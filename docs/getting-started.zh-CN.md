# 快速开始

[English](getting-started.md) · **简体中文**

先选择一种运行方式，启动成功后统一按 [初始化管理员](#初始化管理员) 操作：

| 方式 | 适合 | 环境与入口 |
|---|---|---|
| 便携版 | 直接使用面板 | Windows/Linux x64，自带 Node.js，使用 `mystryctl` |
| 源码管理器 | 从源码构建并统一启停 | Node.js ≥ 22，使用 `PanelManager` |
| 手动开发 | 修改前后端代码 | Node.js ≥ 22，运行两个开发终端 |

所有方式均需另行准备服务端所需的 Java。macOS 没有本 Preview 便携包。配置文件随入口不同而变化，见 [配置文件对照表](configuration.zh-CN.md)；文档中的 `DATA_DIR/...` 表示最终数据根，`MYSTRY_DATA_DIR` 优先于 `DATA_DIR`。

Windows PowerShell 使用 `npm.cmd`；下文通用 npm 脚本在 Linux/macOS 使用 `npm`。

## 便携版（普通用户推荐）

便携包已经包含 Node.js、生产依赖和构建产物。Windows 解压后双击 `mystryctl.cmd`；Linux x64 解压后运行：

```bash
chmod +x mystryctl
./mystryctl start
```

无需执行 `npm install`。请先安装适配目标服务端的 Java；可用 `java -version` 检查默认 PATH 运行时，或在面板中探测并选择其他已安装运行时。完整平台列表、校验、升级和限制见 [便携预览版](portable-release.zh-CN.md)。

## 源码运行环境要求

| 依赖 | 要求 |
|------|------|
| Node.js | **≥ 22**（使用内置 `node:sqlite`，无需编译原生 SQLite 模块） |
| Java | 默认使用 PATH 中的 `java`；部署页和实例设置可选择面板扫描并验证的本机运行时 |
| 操作系统 | 源码管理器支持 Windows（`PanelManager.cmd`）与 Linux / WSL（`PanelManager.sh`）；便携产物由 Windows x64 与 Linux x64 分别构建和冒烟验证 |

面板不接受手填 Java 完整路径。先在运行面板的同一用户环境中执行 `java -version` 检查默认 PATH；需要其他已安装 Java 时，在部署页或实例设置中使用「重新扫描」后的选择器。

## Windows 一键管理（推荐）

安装 Node.js 22 或更高版本后，双击仓库根目录的 `PanelManager.cmd`。它会自动完成：

1. 检查 Node 和 npm。
2. 按 `package-lock.json` 安装依赖，并构建 shared、server 和 web；源码和锁文件没变时跳过。
3. 没有 `.env` 时从 `.env.example` 复制一份。
4. 交给跨平台控制器 `mystryctl`：生成互不相同的随机密钥、检查 Java、后台启动面板并打开浏览器。

依赖下载慢或失败时，运行 `.\PanelManager.cmd mirror` 换一个 npm 下载源，见 [npm 下载源](configuration.zh-CN.md#npm-下载源)。

双击会显示菜单，语言跟随系统（中文系统显示中文，其他显示英文，可用 `MYSTRY_LANG` 指定，见[启动器语言](configuration.zh-CN.md#启动器语言)）。也可以直接使用：

```powershell
.\PanelManager.cmd start
.\PanelManager.cmd foreground
.\PanelManager.cmd stop
.\PanelManager.cmd restart
.\PanelManager.cmd rebuild
.\PanelManager.cmd mirror
.\PanelManager.cmd status
.\PanelManager.cmd logs
.\PanelManager.cmd open
.\PanelManager.cmd reset-password
.\PanelManager.cmd help
```

启动、停止、状态和日志与 Linux 的 `PanelManager.sh`、便携版的 `mystryctl` 是同一套实现，只是配置默认用仓库根目录的 `.env`（设置了 `MYSTRY_CONFIG_PATH` 时用它指定的文件），数据目录按其中的 `DATA_DIR`。日志在仓库根目录的 `logs/`。

后台停止和重启会先取消部署/导入任务，再逐个安全停止正在运行的 Minecraft 实例；不要直接在任务管理器中强杀 Node 进程。

若已有 `.env` 中的密钥不是 64 位十六进制字符串，PanelManager 会先将原文件备份到数据目录下的 `launcher/config-backups/`，再生成合规的新密钥。更换 `JWT_SECRET` 会使旧登录令牌失效，但不会删除管理员、实例或 Minecraft 存档。

## Linux / WSL 源码一键管理

在仓库根目录执行：

```bash
chmod +x PanelManager.sh
./PanelManager.sh start
```

`PanelManager.sh` 检查 Node.js 22、按锁文件补装依赖并构建源码，再交给跨平台控制器 `mystryctl` 生成配置、启动和安全停止。它默认把配置写到 `config/panel.env`、数据写到仓库 `data/`；两者均被 Git 忽略。

如需隔离 WSL 测试数据，请在启动、停止、查看状态等每次操作前使用相同的环境变量：

```bash
export MYSTRY_CONFIG_PATH="${HOME}/mystry-test/config/panel.env"
export MYSTRY_DATA_DIR="${HOME}/mystry-test"
./PanelManager.sh start
```

首次空用户库会自动生成随机密钥，创建管理员 `admin` 和随机 16 位密码，并只在窗口里显示一次。不要把密码或 `panel.env` 分享到聊天、仓库或截图中。可用命令为 `start`、`foreground`、`stop`、`restart`、`rebuild`、`mirror`、`status`、`logs`、`open`、`reset-password` 和 `help`；其中 `rebuild` 会先安全停止面板，再重新安装依赖、构建并启动，和 Windows 的 `PanelManager.cmd rebuild` 相同。

## 手动安装与首次配置

在仓库根目录执行：

```bash
npm install
npm run build -w @mystry/shared
```

仅首次配置时复制环境变量模板；已有 `.env` 请保留并检查所需字段。

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

编辑 `.env`，按 [首次启动必需配置](configuration.zh-CN.md#首次启动必需配置) 生成并填写 `JWT_SECRET` 和 `SETUP_TOKEN`。`SETUP_TOKEN` 只用于初始化管理员，创建管理员后从 `.env` 移除并重启面板即可。

## 开发模式

需要同时运行后端与前端（前端通过 Vite 代理访问 API）。

**终端 1 — 后端**（默认 `http://127.0.0.1:3000`）：

```bash
npm run dev:server
```

**终端 2 — 前端**（默认 `http://127.0.0.1:5173`）：

```bash
npm run dev:web
```

浏览器访问 **http://127.0.0.1:5173**，继续按下方 [初始化管理员](#初始化管理员) 完成首启。

## 生产部署

一次性构建所有工作区包：

```bash
npm run build
```

启动后端（会托管 `apps/web/dist` 静态资源）：

```bash
npm start
```

默认监听 **http://127.0.0.1:3000**，前后端同端口访问。

## 初始化管理员

在浏览器打开面板地址（默认整合面板为 `http://127.0.0.1:3000`，手动开发为 `http://127.0.0.1:5173`）。

### 使用便携版 `mystryctl` 或源码管理器 `PanelManager`（推荐）

1. 首次启动时，启动器已自动创建管理员 `admin` 和随机 16 位密码（只在启动窗口里显示一次），因此浏览器打开会直接显示 **「登录面板」**。
2. 使用窗口里显示的 `admin` 和随机密码登录，然后点击左下角的齿轮进入「面板设置」，点「修改密码」将密码修改为自己的密码（至少 12 个字符）。
3. 忘记密码时，在面板运行期间于终端执行 `reset-password` 命令即可生成新密码。

### 手动运行（`npm start` / `npm run dev:server`）

1. 空用户库时页面显示 **「初始化管理员」**。在「初始化令牌」中填入当前配置文件里的 `SETUP_TOKEN`（默认配置位置见 [配置说明](configuration.zh-CN.md)，请勿外泄令牌或配置文件）。
2. 填写用户名（去除首尾空白后 2–64 个字符）与密码（至少 12 个字符，UTF-8 编码不超过 72 字节），点击 **「创建并进入」**。
3. 创建完成后，从实际使用的配置文件移除 `SETUP_TOKEN` 并重启面板（`mystryctl` 和 `PanelManager` 会自动清理）。若管理员已存在，页面会显示「登录面板」，初始化令牌不能用作登录密码。

看到总览后，按 [分步教程：第一次开服](tutorials.zh-CN.md#教程-1第一次开服推荐-paper) 部署实例，再启动 Minecraft 服务端。

## 常用 npm 脚本

| 命令 | 作用 |
|------|------|
| `npm run dev:server` | 后端热重载开发（`@mystry/server`） |
| `npm run dev:web` | 前端 Vite 开发服务器（`@mystry/web`） |
| `npm run build` | 构建 shared → server → web |
| `npm run portable:test` | 验证便携控制器和发布辅助脚本 |
| `npm run audit:production` | 使用官方 registry 检查生产依赖，阻断 high / critical |
| `npm start` | 运行生产后端 |

## 五分钟上手路径

| 步骤 | 做什么 | 在哪里 |
|------|--------|--------|
| 1 | 按所选入口准备配置、创建管理员并登录 | 管理器提示或当前配置文件、登录页 |
| 2 | 部署 Paper（或导入已有服务端） | 侧栏「一键部署」/「导入服务端」 |
| 3 | 点「启动」 | 实例详情或总览 |
| 4 | 等控制台出现 `Done` | 实例 →「控制台」 |
| 5 | 游戏添加服务器 `127.0.0.1` | Minecraft 客户端 |

想在手机或另一台电脑上打开面板，点顶栏的 **其他设备**，步骤见 [在其他设备上打开面板](user-guide.zh-CN.md#在其他设备上打开面板)。面板装在经 SSH 登录的服务器上时，首次启动会问一句是否允许你自己的电脑或手机打开面板；之后也可以随时运行 `./PanelManager.sh remote on`（便携版为 `./mystryctl remote on`），再在云平台的安全组里放行面板端口。

详细步骤见 [分步教程](tutorials.zh-CN.md) 与 [使用指南](user-guide.zh-CN.md)。

## 首次使用检查清单

1. 安装符合服务端要求的 Java；默认运行时可在面板环境中用 `java -version` 检查，也可稍后在面板内选择扫描到的运行时。
2. 确认已配置不同的 64 位十六进制 `JWT_SECRET` 与 `SETUP_TOKEN`；管理器自动生成，手动运行需自行填写。
3. 管理器启动时用窗口里显示的账号登录；手动配置模式在登录页填写「初始化令牌」、用户名和密码来创建管理员，完成后移除 `SETUP_TOKEN` 并重启。
4. 通过「一键部署」或「导入已有服务端」创建第一个实例；已有的服务端按 [上传文件夹](user-guide.zh-CN.md#上传文件夹) 操作。
5. 在实例详情中启动服务，并在「控制台」查看日志。
6. 改端口、难度等：实例 →「参数配置」→ 保存后 **重启**。

## 故障排查

| 现象 | 可能原因 | 处理 |
|------|----------|------|
| 面板启动失败并提示密钥 | 未配置或格式不是 64 位十六进制 | 为 `JWT_SECRET` 和首次启动所需的 `SETUP_TOKEN` 分别生成随机值 |
| 初始化返回 401 | 初始化令牌缺失或与当前配置不一致 | 在页面填写当前配置文件里的 `SETUP_TOKEN` |
| 初始化返回 409 | 管理员已创建 | 刷新页面，使用已有账号登录 |
| 前端 401 | 未登录或 token 过期 | 重新登录 |
| 启动实例失败 | jar 不存在，或默认 PATH / 已绑定 Java 运行时不可用、版本不匹配 | 检查实例根目录、实例设置中的运行时状态和控制台日志 |
| 部署超时 | 网络无法访问 Mojang / Paper / Fabric API，或任务超过执行超时 | 检查防火墙、代理、任务中心里的失败原因和相关超时配置 |
| 端口占用 | 面板端口或 Minecraft 服务端端口冲突 | 面板端口在当前入口配置文件中修改 `PORT`；游戏端口在实例 `server.properties` 中修改；开发模式还需同步 Vite 代理目标 |

更多配置见 [配置说明](configuration.zh-CN.md)。
