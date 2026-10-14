#!/usr/bin/env bash
# 重建并部署本地改动过的产物。
#
# ## 为什么需要它
#
# `penguin update` 从GitHub Releases 拉官方产物，**整目录替换** `~/.penguin/{bin,lib,web,node}`。
# 我们对这套安装做过四处改动，全部落在被替换的范围内：
#
#   | 产物                        | 承载的改动                                  |
#   |-----------------------------|-------------------------------------------|
#   | lib/.../penguin-core/dist   | trace 分片上限 32MiB、撕裂尾部处理         |
#   | lib/.../penguin-server/dist | usage 预聚合表 + 行缓存 + groupLimit        |
#   | web/                | 页面路由懒加载（首屏 −47%）                 |
#   | lib/dist/penguin.js         | CLI bundle（内联 core 子集）                 |
#
# 源码在 `/root/penguin/verify/repo`，与安装目录分离，**升级不会碰它**。所以恢复办法不是备份
# 产物——升级后产物本来就是新的、干净的——而是**重新构建、重新部署**。这个脚本就是那一步。
#
# ## 为什么不做成 systemd timer
#
# 因为重建要25-30 秒且吃一个核，自动跑等于每次升级后无端消耗一次构建；而真正的失败模式是
# "升级之后没人想起这件事"。这里选择把它做成一条**随时可跑、幂等、有校验**的命令，并挂一个
# 开机自检（`penguin-patch-check.service`）只在检测到产物与源码不一致时提醒。
#
# 用法：
#   penguin-redeploy              # 重建并部署全部
#   penguin-redeploy web          # 只重建 web
#   penguin-redeploy server core  # 只重建这两个包
#   penguin-redeploy --check      # 只校验，不改动（退出码 0=一致 1=不一致）

set -euo pipefail

REPO=/root/penguin/verify/repo
NODE=/root/.penguin/node/bin/node
LIB=/root/.penguin/lib/node_modules/@prismshadow
SERVICE=penguin-web
LOG=/var/log/penguin-redeploy.log

export PATH="/root/.penguin/node/bin:$PATH"

log() { printf '[%s] %s\n' "$(date '+%F %T')" "$*" | tee -a "$LOG"; }
die() { log "失败：$*"; exit 1; }

# ---------- 校验：产物是否还带着我们的改动 ----------
verify() {
  local bad=0
  # web：index.html 引的主 JS 必须是懒加载后的那一版（chunk 数 >150，且没有匿名大chunk）
  local chunks
  chunks=$(find /root/.penguin/web/assets -maxdepth 1 -name '*.js' 2>/dev/null | wc -l)
  if (( chunks < 150 )); then
    log "  web 产物不是懒加载版（chunk 数 $chunks，期望 >=150）"
    bad=1
  fi

  # server：usage 预聚合表
  if ! grep -q usage_daily_rollup "$LIB/penguin-server/dist/index.js" 2>/dev/null; then
    log "  server 产物缺 usage_daily_rollup（预聚合表优化）"
    bad=1
  fi
  if ! grep -q groupLimit "$LIB/penguin-server/dist/index.js" 2>/dev/null; then
    log "  server 产物缺 groupLimit"
    bad=1
  fi

  # core：trace 分片上限
  if ! grep -q maxShardBytes "$LIB/penguin-core/dist/index.js" 2>/dev/null; then
    log "  core 产物缺 maxShardBytes（trace 分片上限）"
    bad=1
  fi
  return $bad
}

if [[ "${1:-}" == "--check" ]]; then
  if verify; then
    log "校验通过：产物与源码一致"
    exit 0
  fi
  log "校验失败：产物已被覆盖，需要 penguin-redeploy"
  exit 1
fi

# ---------- 选择要重建的目标 ----------
TARGETS=("$@")
if (( ${#TARGETS[@]} == 0 )); then
  TARGETS=(web server core)
fi

log "===== 开始（目标：${TARGETS[*]}）====="

cd "$REPO"
if [[ ! -d node_modules ]]; then
  die "$REPO/node_modules 不存在。请先在 repo 里跑一次 pnpm install"
fi

# ---------- 1. web ----------
if [[ " ${TARGETS[*]} " == *" web "* ]]; then
  log "构建 web ..."
  ( cd "$REPO/packages/web" && npx vite build ) >>"$LOG" 2>&1 \
    || die "web 构建失败，见 $LOG"
  local_js=$(ls -S "$REPO/packages/web/dist/assets/index-"*.js | head -1 | xargs basename)
  log "  产物主 JS: $local_js ($(stat -c%s "$REPO/packages/web/dist/assets/$local_js") bytes)"

  # 原子替换：不 rm -rf 目标目录，否则运行中的进程会握着已删除的目录句柄，
  # 表现为"文件明明在、curl 能 200，但某些请求 404"。
  log "部署 web ..."
  rm -rf /root/.penguin/web.new
  cp -r "$REPO/packages/web/dist" /root/.penguin/web.new
  mv /root/.penguin/web /root/.penguin/web.old
  mv /root/.penguin/web.new /root/.penguin/web
  rm -rf /root/.penguin/web.old
  log "  完成（assets js: $(ls /root/.penguin/web/assets/*.js | wc -l)）"
fi

# ---------- 2. server / core ----------
# build_pkg <目录名> <安装包名>
#
# 走 `pnpm build` 而不是 `npx tsup`：server 的 build 脚本是
#   pnpm gen:ifaces && node ... tsup
# —— gen:ifaces 会重新生成 src/ifaces.json（新增 @Use() 依赖后必须跑，否则运行时报
# "'queries' is not a requirement in the table"），而 tsup 还带了 4GB 堆上限的参数。
# 直接跑 tsup 会跳过前者，症状是模块启动时才炸。
build_pkg() {
  local dir=$1 pkg=$2
  log "构建 $pkg ..."
  ( cd "$REPO/packages/$dir" && pnpm build ) >>"$LOG" 2>&1 \
    || die "$pkg 构建失败，见 $LOG"
  local out="$REPO/packages/$dir/dist/index.js"
  [[ -f "$out" ]] || die "$pkg 没有产出 dist/index.js"
  log "  产物 $(stat -c%s "$out") bytes"
  rm -rf "$LIB/$pkg/dist"
  cp -r "$REPO/packages/$dir/dist" "$LIB/$pkg/dist"
  log "  已部署到 $LIB/$pkg/dist"
}

if [[ " ${TARGETS[*]} " == *" server "* ]]; then
  build_pkg server penguin-server
fi
if [[ " ${TARGETS[*]} " == *" core "* ]]; then
  build_pkg core penguin-core
fi

# ---------- 3. 重启 ----------
log "重启 $SERVICE ..."
systemctl restart "$SERVICE"
sleep 8
if systemctl is-active --quiet "$SERVICE"; then
  log "  服务已 active（PID $(systemctl show "$SERVICE" -p MainPID --value)）"
else
  die "服务未起来，看 journalctl -u $SERVICE -n 50"
fi

# ---------- 4. 校验 ----------
log "校验 ..."
if verify; then
  log "===== 完成，校验通过 ====="
else
  die "校验未通过，见上面的日志"
fi

# ---------- 5. 触发懒加载表回填（server 换了新的才会需要）----------
if [[ " ${TARGETS[*]} " == *" server "* ]]; then
  log "确认 usage 预聚合表 ..."
  python3 - <<'PY'
import sqlite3
c = sqlite3.connect("/root/.penguin/data/web.db", timeout=30)
try:
    n = c.execute("select count(*) from usage_daily_rollup").fetchone()[0] or 0
    r = c.execute("select count(*) from usage_records").fetchone()[0]
    print(f"  rollup {n:,} 行 / records {r:,} 行" + ("（需一次查询触发回填）" if n == 0 else ""))
except Exception:
    print("  rollup 表不存在，首次查询时自动建并回填")
PY
fi
