#!/usr/bin/env bash
# Linux / WSL source management entry: once dependencies and the build are done, the safe lifecycle is handed to mystryctl.
set -euo pipefail

PROJECT_ROOT="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
CONTROLLER="$PROJECT_ROOT/scripts/portable/mystryctl.mjs"
NPM_MIRROR_SCRIPT="$PROJECT_ROOT/scripts/npm-mirror.mjs"

# UI language: MYSTRY_LANG first, then LC_ALL / LC_MESSAGES / LANG; Chinese in a Chinese environment, English for everything else.
# C / POSIX means no language is set, so move on to the next item. The result is written back to MYSTRY_LANG, so mystryctl uses the same language.
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

# Picks one of two by UI language.
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

# WSL may inherit the Windows temp directory; prefer /tmp, which has Unix permission semantics.
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

# Only two commands take arguments: mirror <name or number>, remote <subcommand> [arguments] (such as remote on, remote https off).
if [ "$#" -gt 1 ] && [ "$1" = remote ]; then
  [ "$#" -le 3 ] || fail "$(text 'remote 最多带两个参数。' 'remote takes at most two arguments.')"
elif [ "$#" -gt 1 ] && { [ "$#" -gt 2 ] || [ "$1" != mirror ]; }; then
  fail "$(text '每次只能指定一个命令；' 'Specify one command at a time. ')$commands_hint"
fi

# When force is passed, dependencies are reinstalled whether or not the lockfile changed.
ensure_dependencies() {
  if ! command -v npm >/dev/null 2>&1; then
    fail "$(text '未找到 npm。请修复 Node.js 22 或更高版本的安装。' 'npm was not found. Repair your Node.js 22+ installation.')"
  fi

  if [ "${1:-}" = force ] \
    || [ ! -d "$PROJECT_ROOT/node_modules" ] \
    || [ ! -f "$PROJECT_ROOT/node_modules/.package-lock.json" ] \
    || [ "$PROJECT_ROOT/package-lock.json" -nt "$PROJECT_ROOT/node_modules/.package-lock.json" ]; then
    # When following npm's own config the script outputs no URL, so no --registry is added here either.
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

# Same as run_controller, but returns to the script after running, since rebuild has more to do after stopping the panel.
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
    # Toggle "access from other devices": the subcommand and arguments are passed to the controller as is.
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
