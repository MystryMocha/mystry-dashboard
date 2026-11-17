#!/usr/bin/env bash
# Linux / WSL 源码管理入口：依赖与构建完成后交给 mystryctl 处理安全生命周期。
set -euo pipefail

PROJECT_ROOT="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
CONTROLLER="$PROJECT_ROOT/scripts/portable/mystryctl.mjs"
NPM_MIRROR_SCRIPT="$PROJECT_ROOT/scripts/npm-mirror.mjs"

# 界面语言：MYSTRY_LANG 优先，其次 LC_ALL / LC_MESSAGES / LANG；中文环境用中文，其余一律英文。
# C / POSIX 表示没有设置语言，继续看下一项。结果写回 MYSTRY_LANG，让 mystryctl 用同一种语言。
detect_chinese() {
  for value in "${MYSTRY_LANG:-}" "${LC_ALL:-}" "${LC_MESSAGES:-}" "${LANG:-}"; do
    case "$value" in
      ''|C|C.*|C@*|POSIX|POSIX.*) continue ;;
      zh*) return 0 ;;
      *) return 1 ;;
    esac
  done
  return 1
}

if detect_chinese; then
  chinese=1
  export MYSTRY_LANG=zh-CN
else
  chinese=0
  export MYSTRY_LANG=en-US
fi

# 按界面语言二选一。
text() {
  if [ "$chinese" = 1 ]; then printf '%s' "$1"; else printf '%s' "$2"; fi
}

fail() {
  printf '%s%s\n' "$(text '错误：' 'Error: ')" "$*" >&2
  exit 1
}

commands_hint="$(text '可用命令：start、foreground、stop、restart、rebuild、status、logs、open、reset-password、remote、mirror、help。' 'Available commands: start, foreground, stop, restart, rebuild, status, logs, open, reset-password, remote, mirror, help.')"

if [ "$(uname -s)" != 'Linux' ]; then
  fail "$(text 'PanelManager.sh 仅支持 Linux / WSL；Windows 请使用 PanelManager.cmd。' 'PanelManager.sh supports Linux / WSL only. On Windows, use PanelManager.cmd.')"
fi

# WSL 可能继承 Windows 临时目录；优先使用具有 Unix 权限语义的 /tmp。
if [ -z "${TMPDIR:-}" ] || [[ "$TMPDIR" == /mnt/* ]]; then
  export TMPDIR=/tmp
fi

if ! command -v node >/dev/null 2>&1; then
  fail "$(text '未找到 Node.js。请先安装 Node.js 22 或更高版本。' 'Node.js was not found. Install Node.js 22 or later.')"
fi

if ! node_major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null)"; then
  fail "$(text '无法读取 Node.js 版本。' 'Could not read the Node.js version.')"
fi
case "$node_major" in
  ''|*[!0-9]*) fail "$(text '无法识别 Node.js 主版本：' 'Unrecognized Node.js major version: ')$node_major" ;;
esac
if [ "$node_major" -lt 22 ]; then
  fail "$(text "Node.js 版本过低：$(node --version)。本项目要求 22 或更高版本。" "Node.js $(node --version) is too old. This project needs 22 or later.")"
fi

if [ ! -f "$CONTROLLER" ]; then
  fail "$(text '找不到生命周期控制器：' 'Lifecycle controller not found: ')$CONTROLLER"
fi

# 只有两个命令带参数：mirror <名称或编号>，remote <子命令> [参数]（如 remote on、remote https off）。
if [ "$#" -gt 1 ] && [ "$1" = remote ]; then
  [ "$#" -le 3 ] || fail "$(text 'remote 最多带两个参数。' 'remote takes at most two arguments.')"
elif [ "$#" -gt 1 ] && { [ "$#" -gt 2 ] || [ "$1" != mirror ]; }; then
  fail "$(text '每次只能指定一个命令；' 'Specify one command at a time. ')$commands_hint"
fi

# 传入 force 时不管锁文件有没有变化，都重新安装依赖。
ensure_dependencies() {
  if ! command -v npm >/dev/null 2>&1; then
    fail "$(text '未找到 npm。请修复 Node.js 22 或更高版本的安装。' 'npm was not found. Repair your Node.js 22+ installation.')"
  fi

  if [ "${1:-}" = force ] \
    || [ ! -d "$PROJECT_ROOT/node_modules" ] \
    || [ ! -f "$PROJECT_ROOT/node_modules/.package-lock.json" ] \
    || [ "$PROJECT_ROOT/package-lock.json" -nt "$PROJECT_ROOT/node_modules/.package-lock.json" ]; then
    # 跟随 npm 自身配置时脚本不输出地址，这里也就不加 --registry。
    local registry
    registry="$(node "$NPM_MIRROR_SCRIPT" registry)" || exit 1
    printf '%s\n' "$(text '正在根据 package-lock.json 安装依赖…' 'Installing dependencies from package-lock.json…')"
    if [ -n "$registry" ]; then
      printf '%s\n' "$(text 'npm 下载源：' 'npm download source: ')$registry"
    fi
    (
      cd "$PROJECT_ROOT"
      if [ -n "$registry" ]; then
        npm ci --registry="$registry"
      else
        npm ci
      fi
    ) || fail "$(text '依赖安装失败。下载慢或失败时，可以运行 ./PanelManager.sh mirror 换一个 npm 下载源。' 'Installing dependencies failed. If downloads are slow or failing, run ./PanelManager.sh mirror to choose another npm download source.')"
  fi
}

build_sources() {
  printf '%s\n' "$(text '正在构建 shared、server 和 web…' 'Building shared, server and web…')"
  (
    cd "$PROJECT_ROOT"
    npm run build
  )
}

run_controller() {
  cd "$PROJECT_ROOT"
  exec node --no-warnings --experimental-sqlite "$CONTROLLER" "$@"
}

# 和 run_controller 一样，但执行完会回到脚本，rebuild 停止面板后还要继续。
call_controller() {
  (
    cd "$PROJECT_ROOT"
    node --no-warnings --experimental-sqlite "$CONTROLLER" "$@"
  )
}

command="${1:-start}"
case "$command" in
  start|foreground)
    ensure_dependencies
    build_sources
    run_controller "$command"
    ;;
  rebuild)
    call_controller stop
    ensure_dependencies force
    build_sources
    run_controller start
    ;;
  stop|restart|status|logs|open|reset-password|help|-h|--help)
    run_controller "$command"
    ;;
  remote)
    # 开关「从其他设备访问」：子命令和参数原样交给控制器。
    run_controller "$@"
    ;;
  mirror)
    if [ "$#" -eq 2 ]; then
      exec node "$NPM_MIRROR_SCRIPT" set "$2"
    fi
    exec node "$NPM_MIRROR_SCRIPT" show
    ;;
  *)
    fail "$(text "未知命令：$command。" "Unknown command: $command. ")$commands_hint"
    ;;
esac
