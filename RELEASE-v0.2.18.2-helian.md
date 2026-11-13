# 经创贺联 PenguinHarness fork · v0.2.18.2

**基线**：上游 [`Prism-Shadow/penguin-harness`](https://github.com/Prism-Shadow/penguin-harness) `v0.2.18`（`9424ed4f`）
**本分支**：`fork/0.2.18`（源码树里的 `merge/0.2.18`）
**相对 v0.2.18.1**：只多一个服务端修复（见下），其余相同
**规模**：135 个提交 · 255 个文件 · **+27,348 / −937** 行

---

## 本版新增（相对 v0.2.18.1）

**整段历史读取不再把服务器挂死**：`GET /api/sessions/:id/messages` 不带 `tailLimit` 时会读整条
transcript 并塞进一个 JSON。本机最大的会话有 1048 个分片、约 850 MB Trace，这条路径先跑 9 分钟、
再以 `RangeError: Invalid string length` 500 收场。

现在先 `stat` 分片量体积（`traceService.traceBytes`），超过 64 MiB
（`PENGUIN_MESSAGES_FULL_READ_LIMIT_BYTES` 可覆盖）就改答「尾部窗口」：返回
`page.autoWindowed: true` 与 `page.before` 游标，调用方可以继续往回翻；小于阈值的会话仍是
原来的整段读取，响应里没有 `page`。单测 `test/messages-full-read-guard.test.ts`（3 例）
覆盖守卫内/守卫外/显式窗口三条路径。

## 为什么有这个 fork

我们把 PenguinHarness 当作投标出件、演示系统、公司协作的底座，在此之上长期做了两条改造线：

- **Web 线** —— 工单看板、归档页、项目级定时任务、公司/组织面板、品牌本地化；
- **Server 线** —— PostgreSQL 后端、模型健康记忆与换模、定时任务触发、Trace 离线解析、会话全文搜索、用量聚合与缓存。

两条线各自跟上游 rebase/merge，直接 `penguin update` 会把两侧**同时丢掉**。本 release 是两条线在
上游 **v0.2.18** 上的合流版本，并补上了合并期遗漏，是我们在生产里实际运行的那一份。

---

## 相对上游 v0.2.18 带来的东西

### 数据库

- **PostgreSQL 后端 shim**（`PENGUIN_DB=pg`）：把只有 SQLite 的存储层抽象成 `dbcompat` 兼容层，
  含 FTS5 → `tsvector` 翻译、`GROUP BY`、标量 `max/GREATEST`、`DO UPDATE SET` 列限定、
  命名参数复用、CJS worker。**SQLite 仍是默认**，可整体切到 PG 亦可回退。

### Web

- **工单看板**：项目/模块/招标项目分组、审批队列、批量操作、列排序与横向滚动、拖拽防误选、
  单卡解禁与批量解禁。
- **归档**：一级导航「已归档对话」页、归档回执条（撤销 / 查看 / 深链）、行标题可点回原对话、
  来源 Pill。
- **定时任务**：Project 级总览页（一级导航）、手动触发按钮、`auto-paused` 状态与「继续运行」、
  webhook 触发段、失效文件提示。
- **公司 / 组织**：通知中心与财务用量下钻、按员工指定模型、按分组推送开关、频道 `@squad`、
  `@提及` 精确 Markdown 语法与 chip 渲染、看板偏好与 inbox 过滤按组织持久化。
- **聊天页头部「模型速度」芯片**：任务进行中显示当前请求输出速度（流式期按已流出字符估算并标 `≈`，
  请求结束换成实测 `输出 token ÷ 生成秒数`）。
- **品牌本地化**：标题、应用名、图标（经创贺联 / HealthLink）。

### Server / Core

- **模型健康记忆 + 换模**：`model_health` 表（连败计数、质量拉黑），429 之外把
  `timeout / network / connect_failed` 也算可换模型，按降级链顺序跳过 remembered-bad 模型；
  失败即回落到「只走链」。
- **定时任务**：`fireNow` 手动触发、webhook（签名 / 幂等 / 重放）、连续失败自动暂停与恢复、
  inbox 已读与归档、run-based autopilot 规则。
- **性能**：Trace 离线解析 worker、会话全文搜索、用量日聚合、会话列表与用量路由的读缓存、
  侧栏轮询时预热最新会话分片（限频限尺寸）。
- **健壮性**：网关 4xx（`server_error`、空响应体）不再判死；单机切片（远程 machine id 快速失败）。
- **API socket**：`/api/socket` WebSocket 通道（0.2.17 起前端推流依赖它，缺了会「输入完必须刷新才出现」）。

---

## 本次合流修掉的问题

| 问题 | 影响 | 处理 |
| --- | --- | --- |
| 0.2.17→0.2.18 合并把日程页的 machine-aware 调用点冲掉（6 处 tsc） | 定时任务页列表永远空、vite 不报错照发上线 | 补 `machineId`、对齐上游三筛选、修两个测试 |
| 前端升到 0.2.17 但服务端没有 `/api/socket` | 消息要刷新才出现，推理也不显示 | 由本版本的服务端提供该通道；沙箱与线上均已实测 |
| 合并丢掉 Server 线的 `model_health` 与 ladder 换模 | 线上已有的换模健康记忆会被删掉 | 摘回两个提交并补回 `failover-target` 测试 |
| 成本中心 30 秒响应缓存把**价格**也缓存了 | 改价 / 恢复默认 / 改促销后旧价最多显示 30s | 缓存抽成模块，写价钩子 `modelConfigChanged()` 主动失效 |
| `db-migrations` 对 `WITHOUT ROWID` 表仍用 `ORDER BY rowid` | 迁移回归测试崩溃 | 改按主键排序 |
| `db/pg/translate.ts` 13 处类型错误 | `tsc` 不绿 | 正则/边界已保证处补断言 |

---

## 性能（本机实测，2026-11-01）

| 场景 | 优化前 | 现在 | 做法 |
| --- | --- | --- | --- |
| 成本中心用量聚合 | 冷查询 **4.6–5.4 s** | 同参数重复读 **6.7 ms**（≈700×） | 短 TTL 响应缓存 + 30 s 桶量化；改价/换默认/改促销即失效 |
| 大会话历史（窗口化） | 全量读取该会话 `RangeError` 500（130 s → 9 min） | `?tailLimit=50` → **260 KB / 39 ms** | Trace 尾部读取 + 分页游标 |
| 实时推流 | 缺 `/api/socket` 时请求挂死、界面「刷新才更新」 | 回显 **2.4 s**、内容 **13 s**，无 WS 报错 | WebSocket `/api/socket`（cookie 鉴权） |
| Trace 解析 | 大 Trace 在请求线程解析，卡事件循环 | 搬到 `trace-parse-worker` | 独立 worker + 分片索引 |
| 侧栏轮询 | 每次重读最新会话分片 | 限频预热（限尺寸 / 10 分钟 / 每轮 4 个） | `perf(warm)` |

## 验证

| 项目 | 结果 |
| --- | --- |
| `tsc --noEmit`（server / web） | **0 error** |
| 关键单测 | `model-health` 5 · `models-health` 路由 4 · `failover-target` 6 · `session-manager` 49 · `models` 59 · `usage` 45 · `db-migrations` 21 —— 全绿 |
| 线上 `/api/socket` | 升级请求 **401**（路由在、只差凭证）；此前是挂死无响应 |
| 线上 `/models/health` | 200，并保留历史失败记录 |
| 真实登录态推流 | 自己的消息 **2.4s** 出现、助手内容 **13s** 出现，控制台无 WebSocket 报错 |
| 上下文审计（近 14 天 6,634 个会话） | 真正超过模型窗口的会话 **0 个** |

---

## 安装包（自校验，与上游同形）

| 资产 | 适用 |
| --- | --- |
| `penguin-linux-x64.tar.gz` | Linux x64（随包 Node 24.18） |
| `penguin-darwin-x64.tar.gz` / `penguin-darwin-arm64.tar.gz` | macOS Intel / Apple Silicon |
| `penguin-win32-x64.zip` | Windows x64（随包 Node + MinGit） |
| `penguin-universal.tar.gz` | 任意平台，需系统 Node ≥ 24 |
| `penguin-browser-extension*.zip` | Chrome 扩展（可「加载已解压」） |
| `SHA256SUMS` | 全资产校验清单 |

```bash
tar -xzf penguin-linux-x64.tar.gz -C /tmp/penguin-install
PENGUIN_ARCHIVE=/tmp/penguin-install/payload.tar.gz sh /tmp/penguin-install/install.sh
```

安装完 `penguin --version` = `v0.2.18`，`penguin web` 起界面（7364）。
**未提供 `linux-arm64`**：其 payload 需要 arm64 的 `node-pty` 绑定（上游用 docker+qemu 现编），
本次构建机没有 arm64 工具链，不发比发一个终端不可用的包更稳妥。

## 已知问题

- 合流树里仍有 14 个服务端测试套件失败（`archived-sessions`、`authz`、`hmr-host`、`hot-replace`、
  `machine-adopted-sessions` 等）。**已做基线对比**（`git stash` 后同样失败），属合并期既有问题，
  不影响运行，后续逐个修。
- `custom/auto` 这条本地路由别名把 `context_window` 声明为 128k，而网关实际吃下过 671k；
  会话会因此提前压缩、必要时把输出压到 512 token。按网关真实能力调大该值即可（需先确认上限）。

---

## 使用

```bash
pnpm install --ignore-scripts
pnpm --filter @prismshadow/penguin-core  build
pnpm --filter @prismshadow/penguin-hmr   build
pnpm --filter @prismshadow/penguin-server build
pnpm --filter @prismshadow/penguin-web   build
penguin web            # 或：node packages/cli/dist/penguin.js server --port 7364 --host 0.0.0.0
```

Node ≥ 24、pnpm 11。数据根目录默认 `~/.penguin/data`（`PENGUIN_HOME` 可覆盖）。

---

## English summary

A working fork of PenguinHarness on top of upstream **v0.2.18**: a PostgreSQL backend shim (SQLite
stays the default), a ticket board with grouping/approval queues, an archived-conversations page, a
project-level schedules page with manual fire and webhooks, company/organization panels, a live
model-speed chip, model-health memory with chain-ordered failover on quota/transport failures,
off-loop Trace parsing, full-text session search, usage aggregation caches — plus the merge repairs
this release was cut for (the schedule page's half-merged call sites, the missing `/api/socket`
transport, a stale-price bug in the Cost center's response cache). Verified: `tsc` clean, the named
suites green, and live streaming measured end to end.
