# Squad rows show their work group and parent in the sidebar

- **Date:** 2026-10-13
- **Type:** feat
- **Scope:** `web`, `ui`
- **PR:** [#1078](https://github.com/Prism-Shadow/penguin-harness/pull/1078)

[中文版](2026-10-13-squad-row-mark.zh.md)

Sessions spawned with a `squad` tag (see #1035) now carry a users mark in the
sidebar's dim cluster. Its tooltip names the work group and, when parentage is
known, the short parent id. Untagged and archived rows draw nothing new.

## Details

- New `SessionRow` slots `squadGlyph` / `squadLabel`, rendered as a `RowMark`
  right after the source mark; either half alone draws nothing.
- `squadMark()` in `lib/session-source-mark.ts` builds the mark; bilingual
  tooltip via `S.chat.squadSession`.
