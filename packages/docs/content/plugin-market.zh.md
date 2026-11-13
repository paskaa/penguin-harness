---
title: DSH 插件市场
description: 把 DeepSeek Harness 的插件索引接进来，安装时把 dsh 插件转换成本服务器的插件包（技能与 MCP 服务器），并说明转换的边界、安装与卸载的流程。
---

DeepSeek Harness（`dsh`）的插件市场是一份 JSON 索引文件，列出它那边的插件。本服务器的 **DSH 插件市场**页（侧栏，管理员可见）可以读这样的索引，并在**安装时把插件转换**成 PenguinHarness 能运行的插件包。

dsh 插件本身是 **Cordis 插件**：它导出 `apply(ctx)`，运行在 dsh 宿主进程里，并依赖 `@deepseek-ai/dsh-*` 那套服务。本服务器没有这个宿主，所以**不能原样安装**；能搬运的只是两端含义相同的那部分。

## 加一个索引源

1. 打开侧栏的 **DSH 插件市场**。
2. 在「Index sources」里粘贴索引地址，例如官方市场 `https://cdn.dsh.so/market/index.json`（约 9.5 MB、1.2 万个插件），或社区列表 `https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json`。
3. 点 **Add index source**。索引第一次读取要几秒到十几秒：源那一行会显示 `Reading…`，列表先出现骨架屏，读完后自动填上。慢的时候点右上角的 **Refresh**。
4. 只接受 `http(s)` 地址，不能带用户名密码或 `#` 片段。

同一个地址重复添加不会产生第二份。读取失败的源会单独标红并给出原因，其它源照常显示；读成功过一次的源在下次刷新失败时，仍会继续显示上一次的内容。

## 浏览与筛选

- **分类**：索引自己声明的分类会变成一排筛选条（例如「Tools & data 2374」），点一下只看这一类，再点「All」回到全部。数字是当前搜索词下的命中数。
- **搜索**：名称、标题、描述（中英）与关键词都在搜索范围内，由服务器完成（不把整份索引塞进浏览器）。
- **分页**：一页 60 条，「Show more」往下翻。

## 安装时发生了什么

点 **Convert and install** 之后，服务器：

1. 按索引固定的版本，从 npm 取下这个包（只支持 npm 源；`git` 源会明确拒绝）；
2. 找出包里能搬运的内容，写成一个新的包，装在 `<数据根>/plugins` 下，名字统一是 `@dsh-ported/<原名>`；
3. 弹出报告，列出**搬了什么**和**丢了什么**。

| dsh 包里的东西 | 结果 |
| --- | --- |
| `skills/<名>/SKILL.md`（任意层级，如 `data/experts/*/skills/*`）及其文本文件 | 搬成技能；frontmatter 归一为 `name` / `description` / `version` |
| `.mcp.json` 或 `package.json` 的 `mcpServers` | 搬成 `penguin.mcp_servers`；`${TOKEN}` 这类占位记为待填的 vault 键 |
| `icon.svg`、`LICENSE`、`README.md` | 能安全携带时一起带上 |
| MCP 服务器自己的文件：`${PLUGIN_ROOT}/server/index.js` 指向的脚本，或 `args: ["./server.js"]` 所在目录 | 一起搬进包（路径不变，或改写到 `${PLUGIN_ROOT}/mcp/<服务器>/…`），否则服务器装上也起不来 |
| 技能里的图片、PDF、Office 文档、压缩包等 | 按白名单搬（单个 ≤ 5 MB），技能里可以直接引用 |
| `index.js`、`client.js`、`cordis.patch.yml`、`lib/`、`host/` | **丢弃**并在报告里逐项说明（Cordis 宿主代码，本服务器没有对应扩展点） |

两样都没有（既没有 `SKILL.md`，也没有 MCP 声明）的包会被**拒绝**，报告给出原因——装一个什么都不做的空壳没有意义。

安装是后台任务：取包加 `npm install` 要十几二十秒，页面会一直等它结束（期间按钮显示「Converting…」）。服务器重启导致的丢失会明确提示，而不是假装成功。

## 第一次使用前：技能自带的依赖

有的 dsh 技能自带 `package.json` 和自己的安装脚本（例如数据库查询技能依赖 `mysql2`、`redis`）。这些文件原样搬了过来，但依赖要装一次才可用——转换安装的报告里会**标出哪些技能需要这一步**。

把插件装到 Agent 之后，在该技能目录里跑它自己的脚本：

```bash
cd <Agent 的 agent_state>/skills/db-query && bash scripts/setup.sh   # 或 npm install --omit=dev
```

脚本是幂等的，重复跑不会出问题；技能目录里出现 `node_modules` 之后，它的脚本就能正常执行了。

## 装好之后

- 转换出来的包是**库插件**：在「插件市场」页能看到，点它可以**装到某个 Agent** 上——技能进入该 Agent 的技能目录，MCP 服务器进入它的工具配置。
- 需要凭据的 MCP 服务器第一次连接前，要在该 Agent 的设置里把 vault 键填上。
- 同一个插件再点一次是重装（覆盖 `@dsh-ported/<原名>`）。

## 卸载

在 DSH 插件市场里，已安装的卡片会显示 **Installed vX** 和 **Remove**：它把这台服务器上的那个包删掉。已经装到 Agent 上的技能**不会**被自动删除——那是 Agent 自己的东西，需要在该 Agent 的设置页单独移除。

## 巡检：这个市场到底有多少能装

市场页一次装一个；要回答"整体能装多少"，用抽样巡检：

```bash
npx tsx scripts/dsh-market-survey.ts --index https://cdn.dsh.so/market/index.json \
  --sample 50 --out /var/log/dsh-market-survey.json
```

它从索引里均匀抽 N 个插件，走**真实的转换流程**（下载 → 适配），按结果归为
`ported` / `no-content`（宿主插件，无可搬内容）/ `fetch-failed` / `adapt-failed`，
并给出可搬插件的技能数、MCP 数与需要装依赖的数量。不安装任何东西，可以挂定时任务长期跑。

## 限制

- 只支持 **npm 源**；索引里标为 `git` 的版本会被拒绝。
- 只搬运**技能与 MCP 服务器**；改提示词、加 UI、换模型、改会话存储这类深度集成没有等价物。
- 安装的是索引给出的推荐版本（最高正式版），页面还不能挑旧版本。
- 不同 scope 的同名包（`a/x` 与 `b/x`）会落到同一个 `@dsh-ported/x`。
- 索引是第三方内容，插件标题、图标、作者都是发布方自称的；安装前请确认来源。
