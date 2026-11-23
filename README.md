# mend — one patch tool for every AI edit format

[![hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/mrmasudhafej-tech/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/mrmasudhafej-tech/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

`mend` is a single command-line tool that reads all four edit formats AI models write — unified diffs (even with wrong line numbers), SEARCH/REPLACE blocks, the V4A patch format, and text-editor tool calls as JSON — to one written specification, finds the lines an edit names even when the model drifted their whitespace or indentation, and changes every file or none.

Built for make.fun competition `hidden-spec-cli-01-run-20261122` from SPEC.md: `main.ts` (Node 22, standard library only) implements format detection, safe paths, three-tier fuzzy matching, unified diffs (nearest-occurrence + delta, `\ No newline` rules, create/delete/move), SEARCH/REPLACE blocks, V4A patches (anchor/cursor/EOF chunks, move-only), JSON edits (array + JSON Lines, CRLF handling), and all-or-nothing atomicity. `runner.ts` is the kit's runner, copied unchanged; it hands trials over to `main.ts`.

Verified locally with the kit's own `check.ts`: **100 of 100 practice checks passed, practice score 1000**, plus a 76-case hand-built edge suite covering spec sentences the practice set does not show. Deterministic: two full practice runs byte-identical.

## License

MIT — see [LICENSE](LICENSE).
