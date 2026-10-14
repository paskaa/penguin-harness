# 运维脚本

## penguin-redeploy

重建并部署本机对 PenguinHarness 做过改动的产物。

`penguin update` 从 GitHub Releases 拉官方产物，**整目录替换** `~/.penguin/{bin,lib,web,node}`。
本机对这套安装的四处改动全在射程内：

| 产物 | 改动 |
|---|---|
| `lib/.../penguin-core/dist` | trace 分片上限 32MiB、撕裂尾部处理 |
| `lib/.../penguin-server/dist` | usage 预聚合表 + 行缓存 + groupLimit |
| `web/` | 页面路由懒加载（首屏 -47%） |
| `lib/dist/penguin.js` | CLI bundle |

源码在本仓库，与安装目录分离，**升级不会碰它**。所以恢复办法不是备份产物——升级后产物本来
就是新的、干净的——而是重新构建、重新部署。

### 用法

```bash
penguin-redeploy                # 重建并部署全部（约 90 秒）
penguin-redeploy web            # 只重建 web（约 25 秒）
penguin-redeploy server core    # 只重建这两个包
penguin-redeploy --check        # 只校验，不改动；退出码 0=一致 1=已被覆盖
```

`systemd` 钩子 `penguin-patch-check.timer` 每小时（以及开机后 5 分钟）跑一次 `--check`，
不一致就把提示写进 `/var/log/penguin-redeploy.log`。它**只校验不自动重建**——重建要占一个核
90 秒，升级本该是干净的一次动作，不该在开机时悄悄烧一次构建。

### 部署 web 时用原子替换

```bash
cp -r dist /root/.penguin/web.new
mv /root/.penguin/web /root/.penguin/web.old
mv /root/.penguin/web.new /root/.penguin/web
```

不要 `rm -rf /root/.penguin/web` 再 `cp`：静态文件服务会在进程内缓存目录句柄，目录被删掉
重建后，运行中的进程握着的是已删除的目录，表现为「文件明明在、curl 能 200，但某些请求 404」。

### 构建必须走 `pnpm build`

server 的 build 脚本是 `pnpm gen:ifaces && node ... tsup`。`gen:ifaces` 会重新生成
`src/ifaces.json`（新增 `@Use()` 依赖后必须跑，否则运行时抛
`'xxx' is not a requirement in the table`），tsup 还带了 4GB 堆上限参数。直接跑 `npx tsup`
会跳过前者，症状是构建成功、启动时才炸。
