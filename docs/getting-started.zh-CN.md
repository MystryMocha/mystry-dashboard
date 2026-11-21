# 快速开始

[English](getting-started.md) · **简体中文**

先选定一种运行方式；启动后，各方式均按 [初始化管理员](#初始化管理员) 操作：

| 方式 | 适合 | 环境与入口 |
|---|---|---|
| 便携版 | 直接使用面板 | Windows/Linux x64，内置 Node.js，使用 `mdash` |
| 源码管理器 | 从源码构建并统一启停 | Node.js ≥ 22，使用 `mdash.cmd` / `mdash.sh` |
| 手动开发 | 修改前后端代码 | Node.js ≥ 22，运行两个开发终端 |

各方式均不附带 Java：可使用已安装的 Java，或在缺少推荐版本时由面板一键安装 Eclipse Temurin。本预览版暂无 macOS 便携包。配置文件因入口而异，见 [配置文件对照表](configuration.zh-CN.md)；文中 `DATA_DIR/...` 指最终数据根，`MYSTRY_DATA_DIR` 优先于 `DATA_DIR`。

下文的通用 npm 脚本，Windows PowerShell 中用 `npm.cmd` 运行，Linux/macOS 中用 `npm`。

## 便携版（普通用户推荐）

便携包已内置 Node.js、生产依赖与构建产物。Windows 解压后双击 `mdash.cmd`；Linux x64 解压后运行：

```bash
chmod +x mdash
./mdash start
```

无需执行 `npm install`。先安装与目标服务端相符的 Java：可用 `java -version` 检查系统默认 Java，或在面板中扫描并选择其他已安装的运行时。完整平台列表、校验、升级与限制见 [便携预览版](portable-release.zh-CN.md)。

## 源码运行环境要求

| 依赖 | 要求 |
|------|------|
| Node.js | **≥ 22**（使用内置 `node:sqlite`，无需编译原生 SQLite 模块） |
| Java | 默认使用系统默认 Java，即 PATH 中的 `java`；部署页与实例设置中也可选择面板已扫描并验证的本机运行时 |
| 操作系统 | 源码管理器支持 Windows（`mdash.cmd`）与 Linux / WSL（`mdash.sh`）；便携产物在 Windows x64 与 Linux x64 上分别构建并冒烟验证 |

面板不接受手动填写的 Java 完整路径。先在运行面板的同一用户环境中执行 `java -version`，检查系统默认 Java；如需使用其他已安装的 Java，在部署页或实例设置中点「重新扫描」，再从选择器中选取。

## Windows 一键管理（推荐）

安装 Node.js 22 或更高版本后，双击仓库根目录的 `mdash.cmd`，它将自动完成以下步骤：

1. 检查 Node 与 npm。
2. 按 `package-lock.json` 安装依赖，并构建 shared、server 与 web；源码和锁文件均未变化时跳过此步。
3. 若无 `.env`，将 `.env.example` 复制为 `.env`。
4. 交由跨平台控制器 `mdash` 生成互不相同的随机密钥、检查 Java、在后台启动面板并打开浏览器。

依赖下载缓慢或失败时，运行 `.\mdash.cmd mirror` 切换 npm 下载源，见 [npm 下载源](configuration.zh-CN.md#npm-下载源)。

双击后显示菜单，语言跟随系统（中文系统显示中文，其他系统显示英文；可用 `MYSTRY_LANG` 指定，见 [启动器语言](configuration.zh-CN.md#启动器语言)）。也可直接运行以下命令：

```powershell
.\mdash.cmd start
.\mdash.cmd foreground
.\mdash.cmd stop
.\mdash.cmd restart
.\mdash.cmd rebuild
.\mdash.cmd mirror
.\mdash.cmd status
.\mdash.cmd logs
.\mdash.cmd open
.\mdash.cmd reset-password
.\mdash.cmd help
```

启动、停止、状态与日志和 Linux 的 `mdash.sh`、便携版的 `mdash` 共用同一套实现，区别仅在于：配置默认取仓库根目录的 `.env`（若设置了 `MYSTRY_CONFIG_PATH`，则取其指定的文件），数据目录取其中的 `DATA_DIR`。日志位于仓库根目录的 `logs/`。

后台停止与重启时，先取消部署/导入任务，再逐个安全停止运行中的 Minecraft 实例；不要在任务管理器中强行结束 Node 进程。

若现有 `.env` 中的密钥不是 64 位十六进制字符串，源码启动器先将原文件备份到数据目录下的 `launcher/config-backups/`，再生成合规的新密钥。更换 `JWT_SECRET` 将使旧登录令牌失效，但不会删除管理员、实例或 Minecraft 存档。

## Linux / WSL 源码一键管理

在仓库根目录执行：

```bash
chmod +x mdash.sh
./mdash.sh start
```

`mdash.sh` 检查 Node.js 22，按锁文件补装依赖并构建源码，再交由跨平台控制器 `mdash` 生成配置、启动并安全停止面板。配置默认写入 `config/panel.env`，数据写入仓库的 `data/`，两者均被 Git 忽略。

如需隔离 WSL 测试数据，每次操作（启动、停止、查看状态等）前须设置相同的环境变量：

```bash
export MYSTRY_CONFIG_PATH="${HOME}/mystry-test/config/panel.env"
export MYSTRY_DATA_DIR="${HOME}/mystry-test"
./mdash.sh start
```

首次运行且用户库为空时，自动生成随机密钥，创建管理员 `admin` 与 16 位随机密码，密码仅在窗口中显示一次。不要将密码或 `panel.env` 发到聊天、仓库或截图中。可用命令为 `start`、`foreground`、`stop`、`restart`、`rebuild`、`mirror`、`status`、`logs`、`open`、`reset-password` 与 `help`；其中 `rebuild` 先安全停止面板，再重新安装依赖、构建并启动，与 Windows 的 `mdash.cmd rebuild` 相同。

## 手动安装与首次配置

在仓库根目录执行：

```bash
npm install
npm run build -w @mystry/shared
```

仅在首次配置时复制环境变量模板；已有 `.env` 时保留原文件，并检查必需字段。

Windows PowerShell：

```powershell
if (-not (Test-Path -LiteralPath .env)) {
    Copy-Item -LiteralPath .env.example -Destination .env
}
```

Linux/macOS：

```bash
if [ ! -e .env ]; then cp .env.example .env; fi
```

编辑 `.env`，按 [首次启动必需配置](configuration.zh-CN.md#首次启动必需配置) 生成并填写 `JWT_SECRET` 与 `SETUP_TOKEN`。`SETUP_TOKEN` 仅用于初始化管理员；管理员创建后，将其从 `.env` 移除并重启面板。

## 开发模式

须同时运行后端与前端（前端经 Vite 代理访问 API）。

**终端 1 — 后端**（默认 `http://127.0.0.1:3000`）：

```bash
npm run dev:server
```

**终端 2 — 前端**（默认 `http://127.0.0.1:5173`）：

```bash
npm run dev:web
```

在浏览器中打开 **http://127.0.0.1:5173**，再按下文 [初始化管理员](#初始化管理员) 完成首次启动。

## 生产部署

一次构建全部工作区包：

```bash
npm run build
```

启动后端（同时托管 `apps/web/dist` 中的静态资源）：

```bash
npm start
```

默认监听 **http://127.0.0.1:3000**，前后端共用同一端口。

## 初始化管理员

在浏览器中打开面板地址（默认为 `http://127.0.0.1:3000`，手动开发模式下为 `http://127.0.0.1:5173`）。

### 使用 `mdash` 启动（推荐）

1. 首次启动时，启动器已创建管理员 `admin` 与 16 位随机密码（仅在启动窗口中显示一次），因此浏览器打开后直接显示 **「登录面板」**。
2. 以窗口中显示的 `admin` 与随机密码登录，再点击左下角齿轮进入「面板设置」，点「修改密码」设置自己的密码（至少 12 个字符）。
3. 忘记密码时，在面板运行期间于终端执行 `reset-password`，即可生成新密码。

### 手动运行（`npm start` / `npm run dev:server`）

1. 用户库为空时，页面显示 **「初始化管理员」**。在「初始化令牌」中填入当前配置文件里的 `SETUP_TOKEN`（默认配置位置见 [配置说明](configuration.zh-CN.md)；不要外泄令牌或配置文件）。
2. 填写用户名（去除首尾空白后为 2–64 个字符）与密码（至少 12 个字符，UTF-8 编码不超过 72 字节），点击 **「创建并进入」**。
3. 创建完成后，从实际使用的配置文件中移除 `SETUP_TOKEN` 并重启面板（`mdash` 自动清理）。若管理员已存在，页面显示「登录面板」；`SETUP_TOKEN` 不能用作登录密码。

进入总览后，按 [分步教程：第一次开服](tutorials.zh-CN.md#教程-1第一次开服推荐-paper) 部署实例，再启动 Minecraft 服务端。

## 常用 npm 脚本

| 命令 | 作用 |
|------|------|
| `npm run dev:server` | 后端热重载开发（`@mystry/server`） |
| `npm run dev:web` | 前端 Vite 开发服务器（`@mystry/web`） |
| `npm run build` | 构建 shared → server → web |
| `npm run portable:test` | 验证便携控制器与发布辅助脚本 |
| `npm run audit:production` | 以官方 registry 检查生产依赖，存在 high / critical 时阻断 |
| `npm start` | 运行生产后端 |

## 五分钟上手路径

| 步骤 | 做什么 | 在哪里 |
|------|--------|--------|
| 1 | 按所选入口准备配置、创建管理员并登录 | 管理器提示或当前配置文件、登录页 |
| 2 | 部署 Paper（或导入已有服务端） | 侧栏「一键部署」/「导入服务端」 |
| 3 | 点击「启动」 | 实例详情或总览 |
| 4 | 等待控制台输出 `Done` | 实例 →「控制台」 |
| 5 | 在游戏中添加服务器 `127.0.0.1` | Minecraft 客户端 |

如需在手机或另一台电脑上打开面板，点击顶栏的 **其他设备**，步骤见 [在其他设备上打开面板](user-guide.zh-CN.md#在其他设备上打开面板)。面板安装在经 SSH 登录的服务器上时，首次启动会询问一次是否允许你自己的电脑或手机打开面板；此后亦可随时运行 `./mdash.sh remote on`（便携版为 `./mdash remote on`），再在云平台安全组中放行面板端口。

详细步骤见 [分步教程](tutorials.zh-CN.md) 与 [使用指南](user-guide.zh-CN.md)。

## 首次使用检查清单

1. 安装符合服务端要求的 Java：可在面板运行环境中用 `java -version` 检查系统默认 Java，也可稍后在面板内选择扫描到的运行时。
2. 确认 `JWT_SECRET` 与 `SETUP_TOKEN` 已设为互不相同的 64 位十六进制值：管理器自动生成，手动运行须自行填写。
3. 经管理器启动时，以窗口中显示的账号登录；手动配置时，在登录页填写「初始化令牌」、用户名与密码以创建管理员，完成后移除 `SETUP_TOKEN` 并重启。
4. 通过「一键部署」或「导入已有服务端」创建第一个实例；导入已有服务端时，按 [上传文件夹](user-guide.zh-CN.md#上传文件夹) 操作。
5. 在实例详情中启动服务端，在「控制台」查看日志。
6. 修改端口、难度等：实例 →「参数配置」→ 保存后 **重启**。

## 故障排查

| 现象 | 可能原因 | 处理 |
|------|----------|------|
| 面板启动失败并提示密钥 | 未配置，或格式不是 64 位十六进制 | 为 `JWT_SECRET` 和首次启动所需的 `SETUP_TOKEN` 分别生成随机值 |
| 初始化返回 401 | 初始化令牌缺失或与当前配置不一致 | 在页面填写当前配置文件里的 `SETUP_TOKEN` |
| 初始化返回 409 | 管理员已创建 | 刷新页面，以已有账号登录 |
| 前端 401 | 未登录或令牌已过期 | 重新登录 |
| 启动实例失败 | jar 不存在，或系统默认 Java / 已绑定的 Java 运行时不可用、版本不符 | 检查实例根目录、实例设置中的运行时状态与控制台日志 |
| 部署超时 | 网络无法访问 Mojang / Paper / Fabric API，或任务执行超时 | 检查防火墙、代理、「任务中心」中的失败原因及相关超时配置 |
| 端口占用 | 面板端口或 Minecraft 服务端端口冲突 | 面板端口：在当前入口的配置文件中修改 `PORT`；游戏端口：在实例的 `server.properties` 中修改；开发模式下还须同步 Vite 代理目标 |

更多配置见 [配置说明](configuration.zh-CN.md)。
