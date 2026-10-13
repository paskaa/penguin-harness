# 侧栏 squad 行显示编组与上级

- **Date:** 2026-10-13
- **Type:** feat
- **Scope:** `web`、`ui`
- **PR:** [#1078](https://github.com/Prism-Shadow/penguin-harness/pull/1078)

[English](2026-10-13-squad-row-mark.md)

带 `squad` 标签起的子会话（见 #1035）在侧栏灰簇里多一个 users 标记。
tooltip 写编组名，父子关系已知时带上级短 id。无标签与归档行什么都不多画。

## Details

- `SessionRow` 新增 `squadGlyph` / `squadLabel` 槽，紧随来源标记渲染为
  `RowMark`；任一半缺失都不画。
- `lib/session-source-mark.ts` 的 `squadMark()` 组装标记；双语 tooltip
  走 `S.chat.squadSession`。
