// mend: applies AI-written edits in four formats to a tree of text files,
// exactly as SPEC.md (version 1) describes. Node 22+, standard library only.
// Written from scratch for this competition: every format reader, the
// three-tier line matcher, and the all-or-nothing write live in this file.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** A parse/usage/format failure that ends the run with exit code 2. */
class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

/** One edit's failure: reported, rolled back, and later edits still run. */
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

/** A patch's lines: split at \n, one trailing \r removed, no empty tail piece. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** Byte order of paths (UTF-8), for the exit-0 listing. */
function byteLess(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

// ---------------------------------------------------------------------------
// The tree as the edits leave it. `now` holds only paths an edit touched
// (null: deleted); anything else is read from disk on first use and cached.
// ---------------------------------------------------------------------------

class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

interface MovePair {
  old: string;
  nw: string;
}

type EditFn = (tree: Tree, moves: MovePair[]) => void;

// ---------------------------------------------------------------------------
// Files as lines. A file's break is CRLF when its first line feed follows a
// carriage return, LF otherwise; splitting and joining at that break, with
// the final-break flag, round-trips any text byte for byte.
// ---------------------------------------------------------------------------

interface FileState {
  br: string;
  lines: string[];
  final: boolean;
}

function splitFile(text: string): FileState {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { br, lines: parts, final };
}

function joinFile(st: FileState): string {
  if (st.lines.length === 0) return '';
  return st.lines.join(st.br) + (st.final ? st.br : '');
}

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}

function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** All positions where O matches `lines` at one tier. Occurrences may overlap. */
function occurrencesAt(lines: string[], old: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (old.length === 0) return out;
  const want = old.map((l) => normLine(l, tier));
  for (let i = from; i + old.length <= lines.length; i += 1) {
    let ok = true;
    for (let k = 0; k < old.length; k += 1) {
      if (normLine(lines[i + k]!, tier) !== want[k]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** First tier (0, then 1, then 2; only 0 with --strict) with an occurrence. */
function tieredOccurrences(lines: string[], old: string[], from: number, strict: boolean): { tier: number; pos: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const pos = occurrencesAt(lines, old, tier, from);
    if (pos.length > 0) return { tier, pos };
  }
  return null;
}

interface NewItem {
  ctx: boolean;
  text: string;
  /** Position of this context line inside O; unused for non-context lines. */
  oldPos: number;
}

/**
 * Build the replacement lines for a chunk/hunk/block: context lines are the
 * file's own matched lines; every other new line is written as it is, except
 * at tier 2 where a non-empty, non-whitespace-only line starting with P (the
 * leading whitespace of O's first line) has that P replaced by F (the leading
 * whitespace of the file's first matched line); an empty P still counts, so
 * the line gains F at its start.
 */
function buildReplacement(
  oldLines: string[],
  newItems: NewItem[],
  fileLines: string[],
  at: number,
  tier: number,
): string[] {
  const out: string[] = [];
  const F = oldLines.length > 0 ? leadingWs(fileLines[at]!) : '';
  const P = oldLines.length > 0 ? leadingWs(oldLines[0]!) : '';
  for (const it of newItems) {
    if (it.ctx) {
      out.push(fileLines[at + it.oldPos]!);
    } else if (tier === 2 && it.text !== '' && it.text.trim() !== '' && it.text.startsWith(P)) {
      // P may be empty: replacing the empty prefix still prepends F, which
      // is what the specification's wording does (a line starts with P).
      out.push(F + it.text.slice(P.length));
    } else {
      out.push(it.text);
    }
  }
  return out;
}

/** One body line of a unified hunk or a V4A chunk. */
interface BodyItem {
  kind: 'ctx' | 'del' | 'add';
  text: string;
  /** True when a `\` line follows this item in the body. */
  noEol: boolean;
}

/** Split body lines into items, marking each item a following `\` line names. */
function bodyItems(body: string[]): BodyItem[] {
  const items: BodyItem[] = [];
  for (const raw of body) {
    if (raw.startsWith('\\')) {
      const prev = items[items.length - 1];
      if (prev !== undefined) prev.noEol = true;
      continue;
    }
    if (raw === '') {
      items.push({ kind: 'ctx', text: '', noEol: false });
    } else if (raw[0] === ' ') {
      items.push({ kind: 'ctx', text: raw.slice(1), noEol: false });
    } else if (raw[0] === '-') {
      items.push({ kind: 'del', text: raw.slice(1), noEol: false });
    } else if (raw[0] === '+') {
      items.push({ kind: 'add', text: raw.slice(1), noEol: false });
    }
  }
  return items;
}

/** O (context + old) lines and N (context + new) items for a body. */
function oldNew(items: BodyItem[]): { oldLines: string[]; newItems: NewItem[] } {
  const oldLines: string[] = [];
  const newItems: NewItem[] = [];
  for (const it of items) {
    if (it.kind === 'ctx') {
      const pos = oldLines.length;
      oldLines.push(it.text);
      newItems.push({ ctx: true, text: it.text, oldPos: pos });
    } else if (it.kind === 'del') {
      oldLines.push(it.text);
    } else {
      newItems.push({ ctx: false, text: it.text, oldPos: -1 });
    }
  }
  return { oldLines, newItems };
}

/** Whether a `\` line follows the last context or `+` line of the body. */
function lastNewNoEol(items: BodyItem[]): boolean {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const it = items[i]!;
    if (it.kind === 'ctx' || it.kind === 'add') return it.noEol;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Format detection (SPEC section 4).
// ---------------------------------------------------------------------------

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---------------------------------------------------------------------------
// Unified diffs (SPEC section 6).
// ---------------------------------------------------------------------------

interface Hunk {
  a: number;
  items: BodyItem[];
  lineNo: number;
}

interface UnifiedSection {
  oldPath: string | null;
  newPath: string | null;
  newFileMode: boolean;
  deletedFileMode: boolean;
  hunks: Hunk[];
}

function stripAB(p: string): string {
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

/** The path after `--- ` / `+++ `: text after four chars, up to a tab, trimmed. */
function headerPath(line: string): string {
  const rest = line.slice(4);
  const tab = rest.indexOf('\t');
  return (tab >= 0 ? rest.slice(0, tab) : rest).trim();
}

/** Validate a `diff --git a/<X> b/<Y>` line; parse error at its line if malformed. */
function gitPaths(line: string, lineNo: number): { x: string; y: string } {
  const rest = line.slice('diff --git '.length);
  if (!rest.startsWith('a/')) throw new Exit2(`error: parse ${lineNo}`);
  const sep = rest.indexOf(' b/');
  if (sep < 0) throw new Exit2(`error: parse ${lineNo}`);
  const x = rest.slice(2, sep);
  const y = rest.slice(sep + 3);
  if (x === '' || y === '') throw new Exit2(`error: parse ${lineNo}`);
  return { x, y };
}

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(?:$| .*)$/;

function parseUnified(lines: string[], strict: boolean): EditFn[] {
  interface Draft {
    gitOld: string | null;
    gitNew: string | null;
    pairOld: string | null;
    pairNew: string | null;
    pairSet: boolean;
    renameFrom: string | null;
    renameTo: string | null;
    newFileMode: boolean;
    deletedFileMode: boolean;
    hunks: Hunk[];
  }
  const drafts: Draft[] = [];
  let cur: Draft | null = null;
  const startDraft = (d: Draft): void => {
    drafts.push(d);
    cur = d;
  };
  let i = 0;
  const n = lines.length;
  // mode: 'outside' (no section yet, or between sections), 'header' (inside a
  // section, before its first hunk), 'between' (after at least one hunk).
  let mode: 'outside' | 'header' | 'between' = 'outside';

  const collectBody = (start: number): { items: BodyItem[]; next: number } => {
    const body: string[] = [];
    let j = start;
    while (j < n) {
      const l = lines[j]!;
      if (l.startsWith('diff --git ')) break;
      if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
      if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+' || l[0] === '\\') {
        body.push(l);
        j += 1;
      } else break;
    }
    while (body.length > 0 && body[body.length - 1] === '') body.pop();
    return { items: bodyItems(body), next: j };
  };

  while (i < n) {
    const line = lines[i]!;
    const lineNo = i + 1;
    if (line.startsWith('diff --git ')) {
      const { x, y } = gitPaths(line, lineNo);
      startDraft({ gitOld: x, gitNew: y, pairOld: null, pairNew: null, pairSet: false, renameFrom: null, renameTo: null, newFileMode: false, deletedFileMode: false, hunks: [] });
      mode = 'header';
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const oldP = stripAB(headerPath(line));
      const newP = stripAB(headerPath(lines[i + 1]!));
      if (mode === 'header' && cur !== null && !cur.pairSet && cur.gitOld !== null) {
        cur.pairOld = oldP;
        cur.pairNew = newP;
        cur.pairSet = true;
      } else {
        startDraft({ gitOld: null, gitNew: null, pairOld: oldP, pairNew: newP, pairSet: true, renameFrom: null, renameTo: null, newFileMode: false, deletedFileMode: false, hunks: [] });
        mode = 'header';
      }
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      if (mode === 'outside' || cur === null) throw new Exit2(`error: parse ${lineNo}`);
      const m = HUNK_RE.exec(line);
      if (m === null) throw new Exit2(`error: parse ${lineNo}`);
      const { items, next } = collectBody(i + 1);
      cur.hunks.push({ a: Number(m[1]), items, lineNo });
      mode = 'between';
      i = next;
      continue;
    }
    if (mode === 'header' && cur !== null) {
      if (line.startsWith('--- ')) {
        // A `--- ` line inside a section's header, not followed by `+++ `.
        throw new Exit2(`error: parse ${lineNo + 1}`);
      }
      if (line.startsWith('rename from ')) cur.renameFrom = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) cur.newFileMode = true;
      else if (line.startsWith('deleted file mode')) cur.deletedFileMode = true;
      // index / old mode / new mode / similarity / dissimilarity / Index: and
      // every other header line are ignored.
      i += 1;
      continue;
    }
    // Outside a body: prose, fences and every other line are ignored.
    i += 1;
  }

  return drafts.map((d) => unifiedEdit(d, strict));
}

function unifiedEdit(d: {
  gitOld: string | null;
  gitNew: string | null;
  pairOld: string | null;
  pairNew: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  newFileMode: boolean;
  deletedFileMode: boolean;
  hunks: Hunk[];
}, strict: boolean): EditFn {
  const oldRaw = d.pairOld ?? d.renameFrom ?? d.gitOld;
  const newRaw = d.pairNew ?? d.renameTo ?? d.gitNew;
  const oldPath = oldRaw === null ? null : oldRaw === '/dev/null' ? null : oldRaw;
  const newPath = newRaw === null ? null : newRaw === '/dev/null' ? null : newRaw;
  const oldIsNull = oldRaw === '/dev/null';
  const newIsNull = newRaw === '/dev/null';
  const kind: 'create' | 'delete' | 'move' | 'change' =
    oldIsNull || d.newFileMode ? 'create' : newIsNull || d.deletedFileMode ? 'delete' : oldPath !== newPath ? 'move' : 'change';

  return (tree: Tree, moves: MovePair[]): void => {
    if (kind === 'create') {
      if (newPath === null) return;
      if (!safe(newPath)) throw new Fail('unsafe', newPath);
      if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
      const plus: string[] = [];
      for (const h of d.hunks) {
        for (const it of h.items) {
          if (it.kind === 'add') plus.push(it.text);
        }
      }
      // The file ends with a line break unless a `\` line follows the very
      // last `+` line of the whole section.
      let noEol = false;
      outer: for (let hi = d.hunks.length - 1; hi >= 0; hi -= 1) {
        const items = d.hunks[hi]!.items;
        for (let k = items.length - 1; k >= 0; k -= 1) {
          if (items[k]!.kind === 'add') {
            noEol = items[k]!.noEol;
            break outer;
          }
        }
      }
      tree.now.set(newPath, plus.length === 0 ? '' : plus.join('\n') + (noEol ? '' : '\n'));
      return;
    }
    if (kind === 'delete') {
      if (oldPath === null) return;
      if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
      if (tree.get(oldPath) === null) throw new Fail('missing', oldPath);
      tree.now.set(oldPath, null);
      return;
    }
    // Change or move: hunks apply in order to the old file's lines.
    const oldP = oldPath!;
    if (!safe(oldP)) throw new Fail('unsafe', oldP);
    if (kind === 'move') {
      const newP = newPath!;
      if (!safe(newP)) throw new Fail('unsafe', newP);
    }
    const before = tree.get(oldP);
    if (before === null) throw new Fail('missing', oldP);
    if (kind === 'move' && tree.get(newPath!) !== null) throw new Fail('exists', newPath!);
    const st = splitFile(before);
    let delta = 0;
    for (const h of d.hunks) {
      applyUnifiedHunk(st, h, delta, strict, oldP);
      const { oldLines, newItems } = oldNew(h.items);
      delta += newItems.length - oldLines.length;
    }
    const out = joinFile(st);
    if (kind === 'move') {
      tree.now.set(oldP, null);
      tree.now.set(newPath!, out);
      moves.push({ old: oldP, nw: newPath! });
    } else {
      tree.now.set(oldP, out);
    }
  };
}

/** Apply one unified hunk to a file state, in place. Throws Fail on no-match. */
function applyUnifiedHunk(st: FileState, hunk: Hunk, delta: number, strict: boolean, path: string): void {
  const { oldLines, newItems } = oldNew(hunk.items);
  if (oldLines.length === 0) {
    const oldLen = st.lines.length;
    const at = Math.max(0, Math.min(hunk.a + delta, oldLen));
    const added = newItems.map((it) => it.text);
    st.lines.splice(at, 0, ...added);
    if (at === oldLen && added.length > 0) {
      // Insertion landed at the end: the final break follows the last `+` line.
      st.final = !lastNewNoEol(hunk.items);
    }
    return;
  }
  const found = tieredOccurrences(st.lines, oldLines, 0, strict);
  if (found === null) throw new Fail('no-match', path);
  const target = hunk.a - 1 + delta;
  let best = found.pos[0]!;
  let bestDist = Math.abs(best - target);
  for (const p of found.pos) {
    const dist = Math.abs(p - target);
    if (dist < bestDist) {
      best = p;
      bestDist = dist;
    }
  }
  const atEnd = best + oldLines.length === st.lines.length;
  const repl = buildReplacement(oldLines, newItems, st.lines, best, found.tier);
  st.lines.splice(best, oldLines.length, ...repl);
  if (atEnd) {
    if (repl.length > 0) st.final = !lastNewNoEol(hunk.items);
    else st.final = st.lines.length > 0;
  }
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (SPEC section 7).
// ---------------------------------------------------------------------------

interface SRBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
  searchLineNo: number;
}

function parseSearchReplace(lines: string[], strict: boolean): EditFn[] {
  const blocks: SRBlock[] = [];
  let i = 0;
  let prevEnd = -1;
  let prevPath: string | null = null;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchIdx = i;
    let j = i + 1;
    let sep = -1;
    while (j < lines.length) {
      if (lines[j]!.trimEnd() === '=======') {
        sep = j;
        break;
      }
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') break;
      j += 1;
    }
    if (sep < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let k = sep + 1;
    while (k < lines.length && lines[k]!.trimEnd() !== '>>>>>>> REPLACE') k += 1;
    if (k >= lines.length) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let path: string | null = null;
    for (let p = searchIdx - 1; p > prevEnd; p -= 1) {
      const cand = lines[p]!;
      if (blank(cand)) continue;
      if (cand.trim().startsWith('```')) continue;
      path = cand.trim();
      break;
    }
    if (path === null) {
      if (prevPath !== null) path = prevPath;
      else throw new Exit2(`error: parse ${searchIdx + 1}`);
    }
    blocks.push({ path, oldLines: lines.slice(searchIdx + 1, sep), newLines: lines.slice(sep + 1, k), searchLineNo: searchIdx + 1 });
    prevPath = path;
    prevEnd = k;
    i = k + 1;
  }
  return blocks.map((b) => {
    const path = b.path;
    const oldLines = b.oldLines;
    const newLines = b.newLines;
    return (tree: Tree): void => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (oldLines.length === 0) {
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, newLines.length === 0 ? '' : `${newLines.join('\n')}\n`);
        return;
      }
      const before = tree.get(path);
      if (before === null) throw new Fail('missing', path);
      const st = splitFile(before);
      const found = tieredOccurrences(st.lines, oldLines, 0, strict);
      if (found === null) throw new Fail('no-match', path);
      if (found.pos.length > 1) throw new Fail('ambiguous', path);
      const at = found.pos[0]!;
      const newItems: NewItem[] = newLines.map((text) => ({ ctx: false, text, oldPos: -1 }));
      const repl = buildReplacement(oldLines, newItems, st.lines, at, found.tier);
      st.lines.splice(at, oldLines.length, ...repl);
      tree.now.set(path, joinFile(st));
    };
  });
}

// ---------------------------------------------------------------------------
// V4A patches (SPEC section 8).
// ---------------------------------------------------------------------------

interface V4AChunk {
  anchor: string | null;
  items: BodyItem[];
  eof: boolean;
}

type V4ASection =
  | { kind: 'add'; path: string; fileLines: string[] }
  | { kind: 'delete'; path: string }
  | { kind: 'update'; path: string; moveTo: string | null; chunks: V4AChunk[]; updateLineNo: number };

function v4aHeader(line: string): { kind: 'add' | 'delete' | 'update'; path: string } | null {
  for (const [prefix, kind] of [['*** Add File:', 'add'], ['*** Delete File:', 'delete'], ['*** Update File:', 'update']] as const) {
    if (line === prefix) return { kind, path: '' };
    if (line.startsWith(`${prefix} `)) return { kind, path: line.slice(prefix.length).trim() };
  }
  return null;
}

function parseV4A(lines: string[]): V4ASection[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  const last = (() => {
    let k = lines.length - 1;
    while (k >= 0 && blank(lines[k]!)) k -= 1;
    return k;
  })();
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: V4ASection[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    const head = v4aHeader(line);
    if (head === null) throw new Exit2(`error: parse ${i + 1}`);
    const headerLineNo = i + 1;
    let j = i + 1;
    while (j < last && v4aHeader(lines[j]!) === null) j += 1;
    // Content lines with their numbers; blank lines (empty or only
    // whitespace) at the end of a section are not part of it.
    const content: { text: string; lineNo: number }[] = [];
    for (let k = i + 1; k < j; k += 1) content.push({ text: lines[k]!, lineNo: k + 1 });
    while (content.length > 0 && blank(content[content.length - 1]!.text)) content.pop();
    if (head.kind === 'add') {
      const fileLines: string[] = [];
      for (const c of content) {
        if (c.text === '') fileLines.push('');
        else if (c.text.startsWith('+')) fileLines.push(c.text.slice(1));
        else throw new Exit2(`error: parse ${c.lineNo}`);
      }
      sections.push({ kind: 'add', path: head.path, fileLines });
    } else if (head.kind === 'delete') {
      if (content.length > 0) throw new Exit2(`error: parse ${content[0]!.lineNo}`);
      sections.push({ kind: 'delete', path: head.path });
    } else {
      let moveTo: string | null = null;
      let idx = 0;
      if (content.length > 0) {
        const firstLine = content[0]!.text;
        if (firstLine === '*** Move to:' || firstLine.startsWith('*** Move to: ')) {
          moveTo = firstLine.slice('*** Move to:'.length).trim();
          idx = 1;
        }
      }
      const chunks: V4AChunk[] = [];
      let cur: V4AChunk | null = null;
      for (let k = idx; k < content.length; k += 1) {
        const c = content[k]!;
        const t = c.text;
        if (t.startsWith('@@')) {
          const anchor = t.slice(2).trim();
          cur = { anchor: anchor === '' ? null : anchor, items: [], eof: false };
          chunks.push(cur);
        } else if (t.trim() === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${c.lineNo}`);
          cur.eof = true;
          cur = null;
        } else if (t === '' || t[0] === ' ' || t[0] === '-' || t[0] === '+') {
          if (cur === null) {
            if (chunks.length > 0) throw new Exit2(`error: parse ${c.lineNo}`);
            cur = { anchor: null, items: [], eof: false };
            chunks.push(cur);
          }
          const items = bodyItems([t]);
          cur.items.push(...items);
        } else {
          throw new Exit2(`error: parse ${c.lineNo}`);
        }
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headerLineNo}`);
      sections.push({ kind: 'update', path: head.path, moveTo, chunks, updateLineNo: headerLineNo });
    }
    i = j;
  }
  return sections;
}

/** First line at/after `from` equal to a single line at the first tier with one. */
function anchorIndex(lines: string[], anchor: string, from: number, strict: boolean): number | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const want = normLine(anchor, tier);
    for (let j = from; j < lines.length; j += 1) {
      if (normLine(lines[j]!, tier) === want) return j;
    }
  }
  return null;
}

function v4aEdit(sec: V4ASection, strict: boolean): EditFn {
  if (sec.kind === 'add') {
    const path = sec.path;
    const fileLines = sec.fileLines;
    return (tree: Tree): void => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, fileLines.length === 0 ? '' : `${fileLines.join('\n')}\n`);
    };
  }
  if (sec.kind === 'delete') {
    const path = sec.path;
    return (tree: Tree): void => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (tree.get(path) === null) throw new Fail('missing', path);
      tree.now.set(path, null);
    };
  }
  const path = sec.path;
  const moveTo = sec.moveTo;
  const chunks = sec.chunks;
  return (tree: Tree, moves: MovePair[]): void => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const st = splitFile(before);
    let cursor = 0;
    for (const chunk of chunks) {
      if (chunk.anchor !== null) {
        const at = anchorIndex(st.lines, chunk.anchor, cursor, strict);
        if (at === null) throw new Fail('no-match', path);
        cursor = at + 1;
      }
      const { oldLines, newItems } = oldNew(chunk.items);
      if (oldLines.length === 0) {
        const at = chunk.eof ? st.lines.length : Math.min(cursor, st.lines.length);
        const added = newItems.map((it) => it.text);
        st.lines.splice(at, 0, ...added);
        cursor = at + added.length;
        continue;
      }
      const tiers = strict ? [0] : [0, 1, 2];
      let placed: { tier: number; at: number } | null = null;
      for (const tier of tiers) {
        const pos = occurrencesAt(st.lines, oldLines, tier, cursor);
        const ok = chunk.eof ? pos.filter((p) => p + oldLines.length === st.lines.length) : pos;
        if (ok.length > 0) {
          placed = { tier, at: ok[0]! };
          break;
        }
      }
      if (placed === null) throw new Fail('no-match', path);
      const repl = buildReplacement(oldLines, newItems, st.lines, placed.at, placed.tier);
      st.lines.splice(placed.at, oldLines.length, ...repl);
      cursor = placed.at + repl.length;
    }
    const out = joinFile(st);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, out);
      moves.push({ old: path, nw: moveTo });
    } else {
      tree.now.set(path, out);
    }
  };
}

// ---------------------------------------------------------------------------
// JSON edits (SPEC section 9).
// ---------------------------------------------------------------------------

function jsonEdit(v: unknown): EditFn | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree: Tree): void => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree: Tree): void => {
      if (!safe(p)) throw new Fail('unsafe', p);
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree: Tree): void => {
      if (!safe(p)) throw new Fail('unsafe', p);
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const st = splitFile(before);
      if (line < 0 || line > st.lines.length) throw new Fail('no-match', p);
      st.lines.splice(line, 0, ...add);
      tree.now.set(p, joinFile(st));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): EditFn[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: EditFn[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, idx) => {
    if (blank(l)) return;
    let e: EditFn | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${idx + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------------------
// Command line, exit codes, output and atomicity (SPEC sections 1, 2 and 10).
// ---------------------------------------------------------------------------

function parseEdits(kind: string, text: string, lines: string[], strict: boolean): EditFn[] {
  if (kind === 'json') return jsonEdits(text, lines);
  if (kind === 'unified') return parseUnified(lines, strict);
  if (kind === 'search-replace') return parseSearchReplace(lines, strict);
  const sections = parseV4A(lines);
  return sections.map((s) => v4aEdit(s, strict));
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: EditFn[];
  try {
    edits = parseEdits(kind, text, lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const moves: MovePair[] = [];
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = moves.length;
    try {
      edit(tree, moves);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  }
  // Exit 0: one line per changed path, in byte order; a successful move that
  // took a file from before the patch to a new path after it is one `R` line
  // sorting by its new path, replacing that pair's `D` and `A` lines.
  const changed: string[] = [];
  for (const p of tree.now.keys()) {
    if (tree.original(p) !== tree.now.get(p)) changed.push(p);
  }
  const claimedOld = new Set<string>();
  const claimedNew = new Set<string>();
  const rows: { key: string; text: string }[] = [];
  for (let mi = moves.length - 1; mi >= 0; mi -= 1) {
    const pair = moves[mi]!;
    if (claimedOld.has(pair.old) || claimedNew.has(pair.nw)) continue;
    const wasOld = tree.original(pair.old);
    const nowOld = tree.get(pair.old);
    const wasNew = tree.original(pair.nw);
    const nowNew = tree.get(pair.nw);
    if (wasOld !== null && nowOld === null && wasNew === null && nowNew !== null) {
      rows.push({ key: pair.nw, text: `R ${pair.old} -> ${pair.nw}` });
      claimedOld.add(pair.old);
      claimedNew.add(pair.nw);
    }
  }
  for (const p of changed) {
    if (claimedOld.has(p) || claimedNew.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => byteLess(a.key, b.key));
  if (!check) {
    for (const p of changed) {
      if (tree.now.get(p) === null) rmSync(p, { force: true });
    }
    for (const p of changed) {
      const now = tree.now.get(p)!;
      if (now !== null) {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
