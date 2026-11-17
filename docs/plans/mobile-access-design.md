# 在其他设备上打开面板，与公网服务器联机：详细设计（草案）

> 状态：已按本文实现（D-033），尚未做第 9 节的人工验证。日期 2026-11-17。实现与本文不同或没做的地方：WireGuard 入口没做；监听器只按「每个地址一个」实现，没有试 `0.0.0.0` 通配；自带网络的防火墙规则除程序路径外还限定了监听端口；6.3 说只改 `mystryctl.mjs`，实际还要让 `PanelManager.sh` 和 `panel-manager.ps1` 放行 `remote` 及其参数；`remote` 不带子命令时显示状态并可在终端里开关。现行事实以 [当前状态](../ai/current-state.md) 和源码为准。
> 依据：当前 `main`（`0.2.0-preview.4`）源码、在临时目录跑过的原型（HTTP 转交、同端口 HTTPS 加明文跳转、EasyTier 2.6.4 无 TUN）、本机网卡实测、竞品和 EasyTier 的公开文档。若与实现时的源码冲突，以源码为准并修正本文。

## 0. 原则：打开就能用，安全是可选项

- **默认行为参考竞品**。MCSManager、PufferPanel、1Panel 装完都能直接用「IP:端口」打开（附 C）。本设计开启后的默认值是：监听所有网卡、不限来源、**HTTPS（面板自签名证书，和 Crafty 一样）**。浏览器第一次会提示证书不受信任，点一次「继续前往」就能用。
- **安全做成开关，不做成限制**。参考 1Panel 的「面板 SSL」和「授权 IP」，提供两个开关：
  - 使用 HTTPS（自签名证书）：默认开启。不想看到浏览器警告的用户可以关掉，改用不加密的 HTTP；
  - 只允许同一网段的设备：默认关闭。
  界面上说明每个开关的作用，用户怎么选面板都照做，不拦。
- **网卡只给提示，不禁用**。代理软件的虚拟网卡、实例的联机网卡、公网地址都能选，旁边写清楚「其他设备通常连不上」这类说明。
- **保留的几条都不影响用户想做的事**，只是不让面板自己多出漏洞：
  - 启动器接口不需要登录，所以仍只认本机加 `LAUNCHER_TOKEN`；
  - 密钥、令牌、私钥不进日志；
  - 面板自带 EasyTier 只放行面板端口，不把这台电脑上其他程序的端口带进组网。

## 1. 要解决的问题与范围

面板默认只监听 `127.0.0.1`，别的设备打不开。现在要从手机或另一台电脑访问，用户得自己改 `.env` 里的 `HOST`、重启面板、查 IP、手动输入网址，小白走不完。面板装在机房或云服务器上时更麻烦：服务器上没有浏览器，小白也不会 SSH 端口转发。

| # | 内容 | 章节 |
|---|---|---|
| 1 | 「在其他设备上打开」入口，弹窗里显示网址和二维码 | 4 |
| 2 | 只监听本机时，说清别的设备为什么打不开 | 4.2 |
| 3 | 在面板里一键开启或关闭，不改 `.env`、不重启面板，并尝试放行 Windows 防火墙 | 2、3 |
| 4 | 「直接访问」：默认所有网卡，也可以只选一块；网卡下拉显示名字、地址和说明，可刷新 | 2.1、3.2 |
| 5 | 安全开关：HTTPS（自签名证书，默认开启，可关）、只允许同一网段的设备（默认关闭） | 2.5、6.2 |
| 6 | 手机上的「复制」按钮也能用（附带修复） | 4.4 |
| 7 | 「虚拟组网」：面板自带 EasyTier（不用注册，推荐），或已装好的组网软件（Tailscale 等） | 5 |
| 8 | 机房 / 云服务器：经 SSH 首次启动时问一句就能开启；`remote` 系列命令 | 6.1、6.3 |
| 9 | 联机页「公网服务器」直连：填写公网 IP 或域名、安全组和防火墙检查清单、修正误导文案（这一项是**游戏端口**） | 6.4 |

**不做**：免密码扫码登录、自动探测公网 IP（要请求第三方服务）。Let's Encrypt IP 证书放下一期（6.5）。

## 待拍板

暂无。面板自带 EasyTier 的无 TUN 原型已经跑过（5.3「原型结果」），本期按无 TUN 模式做。

已定：
- 默认值参考竞品，安全做成可选开关（第 0 节）。
- 直接访问默认开 HTTPS，用面板自签名证书（同 Crafty），用户可以关掉改用 HTTP（2.5、6.2）。
- 已登录面板就能开启或关闭任何访问方式，不限本机（2.4）。
- 面板自带 EasyTier 本期做，在面板里开启（5.3）。
- 二维码用 `qrcode-generator@2.0.4`（4.3）；复制按钮修复本期一起做（4.4）；联机页公网服务器直连本期做（6.4）。

## 2. 关键决策（实现时写成 D-033）

### 2.1 运行时多挂监听器，不改 `HOST`

`HOST` 和 `.env` 保持不变，面板照常在 `config.host:config.port` 上 `app.listen`。开启访问时，在要开放的每个地址上另起一个 `net.Server`，监听 `<地址>:<config.port>`，把连接交给 Fastify 的 HTTP 服务：

```ts
const sockets = new Set<net.Socket>();
// 与 Node HTTP 服务默认值一致（已核对 http.createServer：allowHalfOpen=true、noDelay=true），
// 否则可能出现响应被截断或控制台输出延迟。
const extra = net.createServer({ allowHalfOpen: true, noDelay: true }, (socket) => {
  // 开了「只允许同一网段」时才检查来源（2.5）。
  if (allowedRange && !isAllowedSource(socket.remoteAddress, allowedRange)) {
    socket.destroy();
    return;
  }
  sockets.add(socket);
  socket.once('close', () => sockets.delete(socket));
  app.server.emit('connection', socket);
});
```

**「所有网卡」怎么实现**：在每个非回环 IPv4 地址上各挂一个监听器，而不是监听 `0.0.0.0`。原因是主监听器已经占着 `127.0.0.1:<port>`，Linux 上同一端口再监听 `0.0.0.0` 通常会报地址被占用（本机 Windows 实测可以共存；Linux 没测，本机 WSL 起不来）。网卡地址会变（DHCP、换 Wi-Fi、插拔网线），所以每 30 秒和每次读状态时重新枚举一次：新地址补挂，消失的地址关掉。实现时先在 Linux 上试一次 `0.0.0.0` 能否和 `127.0.0.1` 共存；能共存就改用一个通配监听器，省掉重新枚举。

「所有网卡」跳过 `instanceNetwork` 地址（3.2）。改用通配监听器时这些地址也会被监听，但实例网络的白名单只放行游戏端口，联机网络里的人仍然连不到面板。

**原型已验证**（Fastify + `@fastify/websocket`，Windows，Node 24，只在 `127.0.0.2` 上测过）：

- 普通 HTTP 请求和 WebSocket 升级都能走通。
- 和 `127.0.0.1` 用同一个端口、只是地址不同，可以同时监听。
- 交过去的连接会触发 `app.server` 的 `connection` 事件，`index.ts` 里的 `openSockets` 能跟踪到，安全关闭流程能覆盖。
- `extra.close()` 只是不再接受新连接，已建立的长连接不会断，必须自己 `destroy()`。关闭时先停止监听、再断开它的连接，那些设备上的会话立即失效。
- `req.ip` 是对方的真实地址（没开 `trustProxy`），`req.socket.localAddress` 是对方连进来的本机地址。

### 2.2 设置存储

存进 `panel_settings`（表已存在，**不需要迁移**），沿用 `download-sources.ts` 的读写方式：

| 键 | 值 |
|---|---|
| `remote_access.direct` | `{ "enabled": true, "interfaceName": null, "restrictToSubnet": false, "https": true }`，`interfaceName` 为 `null` 表示所有网卡；没有这个键或缺字段时按默认值（`https` 为 true） |
| `remote_access.overlay` | `{ "enabled": true, "interfaceName": "Tailscale", "restrictToSubnet": false, "https": false }` |
| `remote_access.panel_network` | 面板自带 EasyTier 的开关、网络名、密钥、节点设置（5.3） |
| `network.public_host` | 用户填的公网 IP 或域名，联机页和面板网址共用（6.4） |

只存网卡名，不存地址，因为 DHCP 或换网都会让地址变化：

- **面板启动**：设置为开启时按网卡名取地址，再挂监听器。某个地址挂不上只跳过它（3.3）；网卡不存在、没有地址或全部地址都挂不上时，**面板照常启动、只监听本机**，记录原因（`interfaceGone` / `noAddress` / `listenFailed`），弹窗里显示。
- **运行中地址变化**：「所有网卡」靠重新枚举自动跟上；选了单块网卡时，读状态发现地址变了就自动换到新地址，并在弹窗里提示「地址已变成 …，二维码已更新」。

### 2.3 `HOST` 优先

`.env` 或环境变量里显式设了非回环的 `HOST`（如 `0.0.0.0`）时，面板本来就对外开放，这是用户自己的选择。弹窗显示「由配置文件决定（`HOST=…`）」、各网卡的网址和二维码，开关只读，不加警告。`HOST` 是回环地址（`127.0.0.1`、`localhost`、`::1`）时才走本设计的开关。

### 2.4 谁能开启：登录即可

- 开启、关闭、换网卡、切换安全选项、重新生成证书、重置组网密钥，任何已登录的请求都可以，不管它来自本机、局域网、组网还是公网。
- 理由：拿到登录令牌的人本来就能控制整个面板（例如上传插件 jar 再重启实例），「只有本机能开启」挡不住攻击者，只会挡住正常用户。
- 在远程设备上关掉自己正在用的方式，自己的连接也会断，点击前提醒一句。
- 服务端记一条日志：「某方式被开启或关闭、操作来自哪个 IP」，不记密钥、令牌和私钥。
- `routes/launcher.ts` 的接口不需要登录，仍只认本机加 `LAUNCHER_TOKEN`。只用 SSH 登录、还没在任何设备上打开过面板的用户，靠启动器命令开启（6.3）。

### 2.5 可选安全项

| 开关 | 直接访问 | 已装的组网软件 | 面板自带 EasyTier |
|---|---|---|---|
| 使用 HTTPS | 默认开启 | 默认关闭（组网本身已加密，省掉浏览器警告），可开 | 没有（连接落在本机的 HTTP 监听器上，EasyTier 本身已加密，5.3） |
| 只允许同一网段的设备 | 默认关闭 | 默认关闭 | 没有（只有加入了这个网络的设备能连） |

本机的 `127.0.0.1` 监听器始终是 HTTP：在这台电脑上打开面板不会出现证书警告，启动器也照旧用 `http://127.0.0.1` 连接。

**使用 HTTPS（自签名证书，直接访问默认开启）**

开启后这些监听器只处理 HTTPS，明文请求自动跳转到 `https://`。细节见 6.2。界面说明：「连接已加密。证书是面板自己签发的，浏览器第一次会提示『不安全』，点『高级』→『继续前往』即可。不想看到这个提示可以关掉 HTTPS，但连接就不再加密。」

**只允许同一网段的设备（默认关闭）**

开启后每个监听器只接受来自自己网卡网段的连接：

| 网卡 | 允许的网段 |
|---|---|
| 一般网卡 | 网卡的 `cidr`（`os.networkInterfaces()` 给出，如 `192.168.2.163/24` → `192.168.2.0/24`） |
| 组网网卡，地址在 `100.64.0.0/10` | `100.64.0.0/10`（本机实测 Tailscale 网卡掩码是 `/32`，按网卡网段会把所有对端挡掉） |
| 掩码为 `/32` 的其他网卡 | 算不出网段。开着这个开关时，这块网卡的地址不监听，网址列表里标 `subnetUnknown` 并说明原因；其他网卡照常 |

- IPv4 映射的 IPv6 形式（`::ffff:192.168.2.10`）要先还原再比较。
- 界面说明：「开启后只有和这台电脑在同一个网络里的设备能打开面板。面板在云服务器上时，开启后你自己的电脑也会连不上。」

### 2.6 防火墙

- **Windows**：开启时尝试加放行规则，沿用 `lan-firewall.ts` 的写法和 `applied | failed | skipped` 三态。
  - 规则名（已改为后面带面板端口，如 `MystryDashboard-Panel-Direct-3000`，见 D-033）：`MystryDashboard-Panel-Direct`、`MystryDashboard-Panel-Overlay`、`MystryDashboard-PanelNet`（面板自带 EasyTier；原型证实它会在 `0.0.0.0` 上开 NAT 检测和打洞端口，Windows 会因此弹窗，规则按 `easytier-core.exe` 的程序路径放行，同实例联机）。
  - 参数：`dir=in action=allow protocol=TCP localport=<config.port> profile=any`；选了单块网卡时加 `localip`；开了「只允许同一网段」时加 `remoteip`；可先试加 `program=<process.execPath>`，加不上再去掉（同 `lan-firewall.ts` 的 fallback）。
  - 先删同名旧规则再添加；关闭时删除；面板启动时清扫残留，关闭面板时也删除。
  - `netsh` 添加规则要管理员权限，面板通常不是以管理员身份运行，所以 **`failed` 是常见情况**。这时界面说明：Windows 第一次可能弹窗询问是否允许 Node.js 访问网络，请选「允许」；没弹窗又连不上，就按给出的步骤手动放行。
  - 用户以前在弹窗里拒绝过 Node.js 时，那条阻止规则优先，界面提醒先删掉它（参考联机页 `multiplayer.lan.firewall` 的措辞）。
- **Linux / macOS**：返回 `skipped`，界面提示「请确认本机防火墙（如 ufw）放行 `<port>` 端口」，给出 `sudo ufw allow <port>/tcp` 和 `firewalld` 的写法。
- **云服务器**：还要在云平台安全组放行，面板读不到也改不了，只能提醒（6.1）。

## 3. 服务端

### 3.1 共享类型（先改 `packages/shared`）

```ts
export type NetworkInterfaceKind =
  | 'lan' | 'overlay' | 'proxy' | 'virtual' | 'instanceNetwork' | 'public';

export interface PanelNetworkInterface {
  name: string;          // 系统网卡名，如 WLAN、以太网、tailscale0
  address: string;       // IPv4
  cidr: string | null;   // 如 192.168.2.163/24
  kind: NetworkInterfaceKind;
}

export type RemoteAccessProblem =
  | 'interfaceGone' | 'noAddress' | 'listenFailed' | 'subnetUnknown' | 'certificateFailed';

export interface RemoteAccessUrl {
  url: string;                        // http(s)://<地址>:<port>/
  interfaceName: string | null;       // 来自 publicHost 时为 null
  kind: NetworkInterfaceKind | 'publicHost';
  listening: boolean;                 // 这个地址有没有挂上；publicHost 跟随是否有任一监听器在工作
  problem: RemoteAccessProblem | null; // 单个地址的问题：listenFailed、subnetUnknown
}

export interface DirectAccessStatus {
  enabled: boolean;
  interfaceName: string | null;       // null 表示所有网卡
  restrictToSubnet: boolean;
  https: boolean;
  urls: RemoteAccessUrl[];            // 所有候选地址（含没挂上的）拼出的网址，加上 publicHost
  problem: RemoteAccessProblem | null; // 整体问题：一个地址都没挂上、网卡不在了、证书失败
  firewall: 'applied' | 'failed' | 'skipped' | null;
}

export interface OverlayAccessStatus {
  enabled: boolean;
  interfaceName: string | null;
  restrictToSubnet: boolean;
  https: boolean;
  urls: RemoteAccessUrl[];
  problem: RemoteAccessProblem | null;
  firewall: 'applied' | 'failed' | 'skipped' | null;
}

export interface PanelCertificateInfo {
  fingerprint256: string;             // X509Certificate.fingerprint256
  notAfter: string;                   // ISO 时间
  addresses: string[];                // 证书里写入的 IP 和域名
}

export interface RemoteAccessStatus {
  managedByConfig: boolean;           // HOST 已是非回环地址（2.3）
  port: number;                       // config.port
  frontendServed: boolean;            // 后端是否在托管前端（开发模式下通常为 false）
  interfaces: PanelNetworkInterface[];
  publicHost: string | null;
  certificate: PanelCertificateInfo | null;
  direct: DirectAccessStatus;
  overlay: OverlayAccessStatus;
  panelNetwork: PanelNetworkStatus;   // 5.3
}

export interface UpdateDirectAccessRequest {
  enabled: boolean;
  interfaceName: string | null;
  restrictToSubnet: boolean;
  https: boolean;
}

export interface UpdateOverlayAccessRequest {
  enabled: boolean;
  interfaceName: string | null;       // 开启时必填
  restrictToSubnet: boolean;
  https: boolean;
}
```

`schemas.ts` 同步加请求体的 JSON Schema。`interfaceName` **只限长度，不限字符**：中文 Windows 的网卡叫「以太网」「WLAN 2」「本地连接* 1」。是否合法只看它在不在本次枚举结果里，**不按类型拒绝**。

### 3.2 网卡分类（只用于默认值和说明）

在 `local-network-service.ts` 新增 `listNetworkInterfaces()`，**不改** `listLanAddresses()` 的返回值和它的测试。只取 IPv4，去掉回环和 `169.254.0.0/16`。

**判定顺序**：先按网卡名，再按地址。用公网段地址的组网软件（如某些 ZeroTier 网络）要靠网卡名认出来，不能先被地址判成 `public`。

| 顺序 | kind | 判定 | 网址旁的说明 |
|---|---|---|---|
| 1 | `instanceNetwork` | 网卡名为 `mystry<数字>`（`lan-config.ts` 的 `dev_name`），或地址在 `10.126.0.0/16` | 「实例的联机网络，只放行游戏端口，其他设备从这里打不开面板」 |
| 2 | `proxy` | 网卡名含 Clash / Mihomo / FlClash，或地址在 `198.18.0.0/15` | 「代理软件的虚拟网卡，其他设备通常连不上」 |
| 3 | `overlay` | 网卡名含 Tailscale / ZeroTier / EasyTier / WireGuard，Linux 上 `tailscale0`、`zt*`、`wg*`；或地址在 `100.64.0.0/10` | 「装了同一组网软件的设备用这个」 |
| 4 | `virtual` | vEthernet、WSL、Hyper-V、VMware、VirtualBox、docker、`br-`、`veth`、`virbr` 等 | 「虚拟机或容器网卡，其他设备通常连不上」 |
| 5 | `lan` | 地址在 `10/8`、`172.16/12`、`192.168/16` | 「同一个 Wi-Fi 或路由器下的设备用这个」 |
| 6 | `public` | 其余地址 | 「公网地址，任何地方都能打开（需要放行防火墙或安全组）」 |

- **网址排序**：`lan`（`192.168` → `10` → `172.16–31`）→ `publicHost` → `public` → `overlay` → 其余。二维码默认显示第一个，点任意网址可切换。
- 「直接访问」的网卡下拉默认「所有网卡」，下面列出全部网卡，每块都能选。「所有网卡」不含 `instanceNetwork`：实例网络的 `tcp_whitelist` 只有游戏端口（已核对 `lan-config.ts`），挂了也连不上，地址还随实例联机启停。
- 「已装的组网软件」的下拉默认第一个 `overlay` 网卡；没有时列出全部网卡，提示「没检测到组网软件」，仍然可以手动选。
- 现有的 `VIRTUAL_INTERFACE_RE` 拆成「代理」「组网」「虚拟机」三组。Linux 的 `^tun` / `^tap` 现在归在虚拟网卡里，`tailscale0` 不以它们开头，要单独匹配。
- 云服务器（VPC）的网卡上常常只有私网地址，公网 IP 由云厂商转发进来。这块网卡被分成 `lan`，「所有网卡」会监听它，公网来的连接能进来（没开「只允许同一网段」时）。网址列表里补上 `publicHost` 拼出的网址（6.4）。这个前提来自通用经验，要在真实云服务器上确认（9 节）。

### 3.3 新服务 `remote-access-service.ts`

职责：读写设置、管理监听器生命周期、拼状态。

- `initRemoteAccess(app)`：`app.listen` 成功后调用；清扫防火墙残留；按设置挂监听器、启动面板自带 EasyTier，失败只记录原因。
- `getRemoteAccessStatus()`：组装 `RemoteAccessStatus`，每次重新枚举网卡（同时完成 2.1 的补挂和关闭）。
- `setDirectAccess(req, body)` / `setOverlayAccess(req, body)`：
  - `managedByConfig` 时抛 `server.remoteAccess.managedByConfig`；
  - 选的单块网卡不存在时抛 `server.remoteAccess.interfaceGone`；
  - 开 HTTPS 时证书生成或读取失败抛 `server.remoteAccess.certificateFailed`，界面给「不加密开启」按钮（同样的请求，`https: false`）；
  - 处理顺序：先停旧监听器、删旧防火墙规则，再逐个地址挂新的，最后写设置；
  - **部分失败**：某个地址监听失败（如别的程序占了这个地址的端口）或算不出网段时，只跳过它，在 `urls[].problem` 里标 `listenFailed` / `subnetUnknown`，其他地址照常；
  - **全部失败**：一个地址都没挂上时抛 `server.remoteAccess.listenFailed`，回到「未监听」，不写入 `enabled: true`；
  - 运行中重新枚举补挂失败时，同样只标出这个地址，不影响已在监听的；
  - 写 2.4 的日志。
- 「直接访问」选了「所有网卡」时，会和「已装的组网软件」选的那块网卡重叠：直接访问跳过已被组网方式占用的地址，网址列表里照样列出。
- `shutdownRemoteAccess()`：在 `index.ts` 关闭流程里、`closeAppWithGrace` 之前调用，停止所有监听器、断开连接、删除防火墙规则、停止面板自带 EasyTier。
- 证书放在单独的 `panel-certificate.ts`（6.2）；面板自带 EasyTier 放在单独的 `panel-network.ts`（5.3）。

### 3.4 路由

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/system/remote-access` | 返回 `RemoteAccessStatus`（刷新按钮也调用它） |
| `PUT` | `/api/system/remote-access/direct` | 请求体 `UpdateDirectAccessRequest` |
| `PUT` | `/api/system/remote-access/overlay` | 请求体 `UpdateOverlayAccessRequest` |
| `POST` | `/api/system/remote-access/certificate` | 重新生成证书；HTTPS 开着时立即换用 |
| `PUT` | `/api/system/remote-access/panel-network` | 开关面板自带 EasyTier、改节点设置（5.3） |
| `GET` | `/api/system/remote-access/panel-network/join` | 返回手机加入要用的网络名、密钥、节点（5.3） |
| `POST` | `/api/system/remote-access/panel-network/reset-secret` | 重置网络名和密钥（5.3） |
| `PUT` | `/api/system/public-host` | 公网 IP 或域名（6.4） |
| `GET` | `/api/launcher/remote-access` | 启动器用，返回 `RemoteAccessStatus` |
| `PUT` | `/api/launcher/remote-access/direct` | 启动器用，请求体同上 |
| `POST` | `/api/launcher/remote-access/certificate` | 启动器用，重新生成证书 |

- `/api/system/*` 需要登录，前端在 `api.ts` 里各加一个调用。
- `/api/launcher/*` 放在 `routes/launcher.ts`，不需要登录令牌（启动器没有），只认回环 `req.ip` 加 `X-Launcher-Token`，和现有的关闭、重置密码接口一样。
- 返回给用户的错误用 `server.remoteAccess.*` / `server.panelNetwork.*` 消息键，英文模板放 `packages/shared/src/messages/`，翻译放 `apps/web/src/i18n/zh-CN/server/`、`zh-TW/server/`。

### 3.5 现有安全边界（已核对源码，只列实现时要注意的）

登录检查按路由挂（`app.authenticate`）。开启访问后，这些**不需要登录**的接口能被其他设备访问到：

| 接口 | 现有保护 | 实现时要做的 |
|---|---|---|
| `GET /api/health` | 无；会返回启动器的进程指纹 `processFingerprint` | 指纹只对回环请求返回（它只用来让启动器认出自己启动的面板） |
| `GET /api/auth/status` | 无，只返回是否需要初始化 | 无 |
| `POST /api/auth/setup` | `X-Setup-Token` 必须匹配，另有限流 | 无；首次启动时启动器先建好管理员再开启访问（6.3） |
| `POST /api/auth/login` | 失败限流，按「来源 IP + 用户名」计数（`security-service.ts`） | 无 |
| `routes/launcher.ts` 的全部接口 | 只认回环 `req.ip`，另需 `LAUNCHER_TOKEN` | 补测试：从额外监听器进来被拒绝 |
| 控制台 WebSocket、文件下载、备份下载 | 一次性 ticket（登录后才能申请） | 无 |

- 其余路由组都在 `preHandler` 里挂了 `app.authenticate`。服务端没有 Origin 校验，令牌放在 `Authorization` 头里、不用 Cookie，CORS 列表不用改。
- 控制台 WebSocket 的地址按 `location.protocol` 选 `ws` 或 `wss`（`ConsolePanel.tsx`），开 HTTPS 不用改前端。
- 首个管理员由启动器自动创建，密码 16 位随机（`mystryctl.mjs` 的 `createInitialAdmin`）；用户自己改密码时 `schemas.ts` 要求至少 12 位。

## 4. 前端

### 4.1 入口与组件（按 `docs/design-system.md`）

- **桌面入口**：`App.tsx` 顶栏 `topbar-right` 的 `toolbar-group` 里，放在 `TaskCenter` 前面，`toolbar-button` 加 Lucide `MonitorSmartphone` 图标（16px），`aria-label` 为「在其他设备上打开」。1024px 以下工具栏标签本来就隐藏，只剩图标。
- **窄屏入口**：768px 以下顶栏不加按钮（CHANGELOG 记录过窄屏顶栏标题被截断），改在「本机」页（`NodesPage`）放一行 `list-row`「在其他设备上打开」，点开同一个弹窗。
- **弹窗**：原生 `<dialog>`，沿用 `confirm-dialog` / `confirm-dialog-panel` / `-title` / `-body` / `-footer`，768px 以下自动变成底部面板。
- **分段**：顶部 `segmented` 切换「直接访问」「虚拟组网」，默认直接访问；只开了虚拟组网时默认显示它。
- **内容组件**：网卡选择用 `field` + `input`（下拉）+ `field-help`；网址用 `list-group` / `list-row`；两个安全开关用 `switch`，放在「安全选项」小标题下；说明用 `callout-info`，防火墙失败用 `callout-warning`；「开启」用 `btn-primary`，「关闭」用 `btn`；刷新用 `btn btn-icon`。
- **二维码**：画在固定白底上（保证能扫），四周留白，不跟随深色主题反色。

### 4.2 「直接访问」分段的状态

| 状态 | 显示 |
|---|---|
| 配置文件管理（`managedByConfig`） | 2.3 的说明、各网卡网址和二维码；没有开关 |
| 未开启 | 「面板现在只允许这台电脑访问，其他设备打不开」；网卡下拉（默认所有网卡）；安全选项（HTTPS 默认勾上）；「开启」按钮 |
| 已开启 | 二维码、网址列表（每条带 3.2 的说明和复制按钮，没挂上的地址灰显并写原因）；开着 HTTPS 时，二维码下写「第一次打开会提示不安全，点『高级』→『继续前往』」和证书指纹；防火墙结果；安全选项（改动立即生效）；「关闭」按钮 |
| 有问题（`problem`） | 对应原因和操作：网卡不在了请重新选、端口被占用、证书生成失败（附「不加密开启」按钮） |
| 后端没托管前端（`frontendServed` 为 false） | 「当前是开发模式，用这个网址打开看不到界面，请用构建后的面板或便携包」 |

- 网址列表里有 `lan` 地址、又没有 `publicHost` 时，列表下面固定一句：「面板在云服务器上？填上公网 IP 或域名，就能生成从外面打开的网址。」点开是 6.4 的公网地址输入框。
- 下拉、刷新和开关在请求进行中禁用，失败时显示服务端返回的错误。

### 4.3 二维码

**已定**：采用 `qrcode-generator`，在浏览器本地生成，不调用外部服务。已在 npm 核对：

| 项 | 值 |
|---|---|
| 版本 | `2.0.4`（2025-08-07 发布），在 `apps/web` 的 `dependencies` 里写死 `"2.0.4"` |
| 许可 | MIT |
| 运行时依赖 | 无，只新增这一个包 |
| 类型与模块 | 自带 `dist/qrcode.d.ts` 和 ESM 入口，不需要 `@types` |

- 字节模式、纠错等级 `M`，版本号交给库自动选。
- 在组件里取模块矩阵自己画成 SVG，不用库的 `createImgTag` / `createSvgTag`，不用 `dangerouslySetInnerHTML`。
- 网址用服务端返回的 `urls`，不用 `window.location` 拼。面板自带 EasyTier 的加入信息二维码见 5.3。
- 更新 `package-lock.json` 并通过 `lockfile:check`；装完实时跑依赖审计，结果写进交付报告；构建后核对包体积增量。

### 4.4 复制在手机上也要能用

关掉 HTTPS 后用 `http://192.168.x.x` 打开、或用组网地址打开面板时不是安全上下文，`navigator.clipboard` 不可用；跳过警告后的自签名 HTTPS 页面在各浏览器里算不算安全上下文，没核实。现有 5 处直接调用（`ConsolePanel`、`DirectSection`、`ErrorSummary`、`LanSection`、`MultiplayerTab`），几处没有判空会直接报错。新增公共 `copyText()`：优先 `navigator.clipboard`，不可用时退回 `textarea` 加 `document.execCommand('copy')`，都失败时提示长按手动复制。5 处统一改用它。

### 4.5 文案

新增 `i18n/en/remoteAccess.ts`（键以 `remoteAccess.` 开头），同步补齐 `zh-CN`、`zh-TW`，并在三份 `index.ts` 里注册。通用动作用 `common.ts` 术语表（如 `action.copy`）。英文标题和按钮用 Title Case（"Open on Another Device"），说明用 sentence case。

文案语气是**说明，不是警告**。弹窗里只放一句：「开启后，能连到这台电脑的设备都能打开面板的登录页。连接默认加密；需要的话，可以在下面的安全选项里限制来源。」

## 5. 虚拟组网分段

手机不在同一个 Wi-Fi（用流量、在学校、在公司），或者面板在机房、又不想直接开放端口时用。组网软件在电脑和手机之间建一条加密的虚拟网络。

### 5.1 两种做法，都本期做

| 做法 | 用户要做什么 | 面板要做什么 |
|---|---|---|
| A. 面板自带 EasyTier（默认推荐） | 手机装 EasyTier，填入面板给的网络名和密钥 | 起一个面板专用的 EasyTier 网络，给出加入信息和网址 |
| B. 已装的组网软件（Tailscale、ZeroTier 等） | 电脑和手机都装好同一个组网软件并登录 | 在组网网卡上挂监听器 |

分段里用小号 `segmented` 切换「面板自带」「已装的组网软件」：检测到 `overlay` 网卡时默认后者，否则默认前者。两者可以同时开启。README 的卖点是「无需注册账号」的内置 EasyTier，面向的小白多半没装任何组网软件，所以 A 是默认推荐。

### 5.2 做法 B：已装的组网软件

- 网卡下拉、来源限制见 3.2、2.5；防火墙规则 `MystryDashboard-Panel-Overlay`，见 2.6。
- 没检测到 `overlay` 网卡时的说明：「没检测到组网软件。电脑和手机都装上 Tailscale 等组网软件并登录同一个账号后，点刷新。」不放具体产品的下载链接。
- 二维码和网址用虚拟地址，手机要先打开组网软件。

### 5.3 做法 A：面板自带 EasyTier

**和现有实例联机网络的关系**

现有的实例虚拟局域网（D-024，`lan-manager.ts`）是发给朋友进服用的：每个实例一个网络，地址 `10.126.<octet>.1`，只放行游戏端口。面板自带的是**另一个独立网络**，只给自己的手机和电脑用，只放行面板端口。两者网络名、密钥、地址段都不同，不能混用：把实例网络的密钥发给朋友，朋友不会因此能打开面板。

复用的部分：
- `lan-runtime.ts`：钉死版本 EasyTier `2.6.4` 的下载、SHA-256 校验和安装；
- `lan-config.ts`：节点校验 `normalizeLanPeers`、社区共享节点 `LAN_SHARED_PEERS`、日志里的密钥脱敏；
- `lan-manager.ts` 的做法：子进程脱敏环境 `getMinecraftChildEnv()`、RPC 端口只监听回环、用 `easytier-cli` 读状态、`generation` 防止旧进程的回调改到新状态。

公共部分抽成小函数，不把面板网络塞进按实例设计的 `instance_lans` 表和 `lan-manager.ts` 里的 `runtimes` 映射。

**先做原型（实现前必须确认）**

EasyTier 文档说无 TUN 模式（`--no-tun`）不需要 root：别的节点可以通过虚拟 IP 用 TCP、UDP、ICMP 访问这个节点，但这个节点不能主动访问别人。面板只需要「被手机访问」，正好合适，而且**不用管理员身份、不建虚拟网卡**，绕开了现有实例联机在 Windows 上的 `server.lan.needsAdmin` 门槛。但下面几点文档没写，要用钉死的 `2.6.4` 实测：

1. 对端访问无 TUN 节点的 `<虚拟IP>:<面板端口>` 时，连接以什么来源地址、落到本机哪个地址（猜测是 `127.0.0.1`），能不能和本机自己发起的连接区分开。
2. 无 TUN 模式下 `tcp_whitelist` 是否仍然生效：只放行面板端口时，本机其他端口（实例的 RCON、EasyTier 自己的 RPC 端口等）从组网里访问不到。
3. Windows 非管理员身份下，无 TUN 模式能否启动并被访问。
4. 手机用 DHCP 加入时，拿到的地址是否在面板节点所在的 `/24` 里。
5. Android 版 EasyTier 能否导入配置（剪贴板、文件或扫码）。
6. WireGuard 入口（见下文）在无 TUN 模式下能否访问面板节点自己的虚拟 IP，以及客户端配置怎么从命令行取出。

**原型结果**（2026-11-17，征得同意后跑过）

条件：本机 Windows 11、非管理员身份、钉死的 `2.6.4`（SHA-256 与 `lan-runtime.ts` 一致）。起了两个无 TUN 节点，只经 `127.0.0.1` 互连，不连社区节点：A 模拟面板（固定 `10.127.0.1`，白名单只放行测试端口 P），B 模拟手机（DHCP，用 `port-forward` 发起连接）。本机另起两个只监听回环的测试服务：P 模拟面板，Q 模拟 RCON 这类只给本机用的服务。

| # | 结论 |
|---|---|
| 1 | 连接落在 `127.0.0.1:<端口>`，来源也是 `127.0.0.1:<随机端口>`，和本机自己发起的连接**分不出来**。面板不用另挂监听器，主监听器直接收到 |
| 2 | **成立**。白名单只放行 P 时，P 能连，Q 连不上；对照组去掉白名单后，Q 也能连上。白名单是唯一的防线，测试必须锁住 |
| 3 | **成立**。非管理员身份下能启动、能被访问；没解压 `wintun.dll` 也能跑，说明无 TUN 模式不加载 TUN 驱动 |
| 4 | **成立**（只测了一台设备）。B 用 DHCP 拿到 `10.127.0.2/24`，在面板节点的网段里 |
| 5 | 没测，要在 Android 真机上试 |
| 6 | **部分成立**。无 TUN 模式下能开 WireGuard 入口，`easytier-cli vpn-portal` 能取出客户端配置（`AllowedIPs` 含 `10.127.0.0/24`）；但 `Endpoint` 要换成公网地址，`Address` 要自己从客户端网段里分配。没用真的 WireGuard 客户端连过 |

另外发现四点：

- **Windows 上必须带 `Packet.dll`**：`easytier-core.exe` 一启动就要加载它，缺了直接报 `0xC0000135`（找不到 DLL），连 `--version` 都跑不起来。面板现在只解压 core、cli 和 `wintun.dll`（`lan-runtime.ts` 的 `extraNames`），见附 B。
- **会弹 Windows 防火墙窗口**：节点监听只写 `127.0.0.1` 也一样，因为 EasyTier 还会在 `0.0.0.0` 上开 UDP / TCP 端口（NAT 检测、打洞等）。原型运行时就弹了，规则是按程序路径建的。面板网络要和实例联机一样处理防火墙（2.6）。
- **STUN 关不干净**：`stun_servers = []` 只关掉了 UDP STUN；TCP 的 NAT 检测仍会连公网 STUN 服务器的 3478 端口，开着代理软件 TUN 模式时会经过代理。正式运行本来就要连社区节点、要打洞，这条只说明「完全不联网」做不到。
- **本机节点互连要关 `bind_device`**：EasyTier 默认把发出的连接绑到物理网卡地址，再连 `127.0.0.1` 时 Windows 报 10049。正式运行连的是外部节点，不受影响；只有测试，或用户把自定义节点填成本机地址时才会遇到。

**补充实测**（2026-11-17，同样条件，B 用 `port-forward`）：面板另开组网专用端口 N、白名单只放 N 时，连「虚拟地址:N」落到 `127.0.0.1:N`（`localPort` 为 N，来源 `127.0.0.1`），连「虚拟地址:面板端口」超时；对照组把面板端口也放进白名单后两个都能连上。所以按本机端口能分出组网来的连接，实现见 D-033。B 用 `socks5` 时连不通，原因没查，正式运行不涉及。

**第 2 点是硬条件**：以后升级 EasyTier 版本时，白名单在无 TUN 模式下一旦不生效，就不能再用无 TUN 模式，否则这台电脑上只监听本机的程序都会暴露给组网，属于第 0 节说的「面板自己多出漏洞」。升级时要重跑这个原型。

本期按无 TUN 做。只有以后第 2、3 点不再成立，或者换到其他平台时不成立，才退回 TUN 模式：
  - 只监听本机的程序不会出现在虚拟 IP 上，`tcp_whitelist` 照样只放行面板端口；
  - Windows 上要管理员身份，沿用 `server.lan.needsAdmin` 的提示；
  - 面板在虚拟 IP 上另挂监听器，「只允许同一网段」开关可用；
  - 防火墙加 `localip=<虚拟 IP>` 的规则。

**网络与进程（按无 TUN 写，`panel-network.ts`）**

- **身份**：
  - 网络名 `mystry-panel-<32 位十六进制>`；
  - 密钥用 26 个字符的 base32，约 130 位，显示时每 4 个一组。比实例网络的 64 位十六进制好输入，强度足够。
  - 存在 `panel_settings` 的 `remote_access.panel_network`：`{ enabled, networkName, networkSecret, useSharedPeers, customPeers }`。和实例网络一样，密钥同时在数据库和 `core.toml` 里（已核对：实例网络存在 `instance_lans.network_secret`）。
- **地址**：面板节点固定 `10.127.0.1`，网段 `10.127.0.0/24`。这个网段不在实例用的 `10.126.0.0/16` 里，EasyTier 默认的 `10.126.126.0/24` 也在那个范围内。手机和其他设备用 DHCP 加入。
- **配置**（写进工作目录的 `core.toml`，密钥不进命令行，文件按 `forceSecureSensitiveFile` 设权限）：
  - `instance_name` 和 `hostname` 都是 `mystry-panel`；
  - `ipv4 = "10.127.0.1"`，`dhcp = false`；
  - `listeners` 用随机端口，同实例网络，方便直连；
  - `tcp_whitelist = ["<面板端口>"]`，`udp_whitelist = ["1"]`；
  - `[flags]`：`private_mode = true`、`no_tun = true`、`enable_exit_node = false`；
  - `[[peer]]`：社区共享节点加用户自定义节点，节点设置可以改，同实例网络。
- **生命周期**：
  - 开启时如果 EasyTier 还没安装，先下载安装，界面显示「正在下载 EasyTier」；
  - 面板启动时，设置为开启就自动启动；面板关闭时停止；
  - 进程退出时，状态改为 `error` 并显示原因，原因用现有 `lanFailureDetail` 解析，同样脱敏密钥；
  - 平台不在 `lanPlatformSupported()` 里时，这个选项不可用，说明原因。
- **面板怎么收到连接**（已改：现在另开组网专用端口，白名单只放它，经它进来的连接不算本机，下面两条后果不再成立，见 D-033 和 5.3 的补充实测）：原型证实连接落到 `127.0.0.1:<面板端口>`，来源也是 `127.0.0.1`，所以不用另挂监听器，主监听器直接收到。
  - 这样 `req.ip` 是 `127.0.0.1`：日志里看不出是哪台手机，登录限流把整个组网算成一个来源。可以接受。
  - 服务端按回环地址放行的只有 `routes/launcher.ts` 的 `isLoopbackAddress`（已搜索源码核对），加上本设计 3.5 的「进程指纹只给回环请求」。组网里的设备会通过这两处判断：
    - 启动器接口仍要 `LAUNCHER_TOKEN`，挡得住；
    - 进程指纹会被组网里的设备看到。它只用来让启动器认出自己启动的进程，不是密钥，可以接受。
  - 原型显示按地址分不出组网来的连接，所以只能按回环处理，上面两处的后果都接受。
  - `tcp_whitelist` 是关键：没有它，本机所有只监听回环的程序都会暴露给组网，所以要写测试锁住。
- **已加入的设备**：用 `easytier-cli` 读对端列表，显示主机名、虚拟 IP、直连还是中转。用户能看到「手机已加入」，也能发现不认识的设备。

**手机怎么加入（分平台）**

- **Android**：
  - 从 EasyTier GitHub 发布页下载 `2.6.4` 的 APK（新手机选 arm64）。界面给链接，并说明 GitHub 慢时可以用镜像，文件一致就行。
  - 在 App 里新建网络，填网络名、密钥、节点，勾上 DHCP。
  - 面板分别给出这三项和复制按钮，再给一个「加入信息」二维码。二维码内容是这三项的纯文本：用手机相机或扫码工具扫出来，就能复制，不用手输密钥。如果原型发现 App 能导入配置，改成直接导入。
- **iOS**：
  - 2.6.4 的官方下载页没有列出 iOS 客户端。App Store 上能搜到几个第三方开发者发布的 EasyTier 客户端，来源没法确认，面板不推荐。
  - 界面如实说明：iPhone 请用「已装的组网软件」（如 Tailscale），或者在面板有公网 IP 时用下面的 WireGuard 入口。
  - （更正：之前写过「iOS 版要求 iOS 16 以上」，这次核对官方下载页没有 iOS 版，以本条为准。）
- **另一台电脑**：给出 EasyTier 图形界面的填写说明，以及等价的 `easytier-core` 命令。命令参数和现有朋友命令一样，带 `--dhcp`、`--no-listener=true`、`--private-mode=true`、`--tcp-whitelist 1`。
- **加入之后**：第二步显示面板网址 `http://10.127.0.1:<port>/` 的二维码。

**WireGuard 入口（可选，原型通过才做）**

EasyTier 节点可以当 WireGuard 服务端，手机用官方 WireGuard App（iOS、Android 都有）扫码导入配置就能进组网，不用装 EasyTier。这是 iPhone 用户的主要途径。
- **条件**：手机要能直接连到这个 UDP 端口，所以只适合有公网 IP 的服务器（放行该 UDP 端口），或者手机和电脑在同一个局域网。
- **界面**：网址用 `publicHost`，没填时提示先填；客户端配置用二维码显示。
- **注意**：客户端配置里含私钥，只在用户点「显示」时生成和展示。
- **待核实**：配置文件的写法和 CLI 子命令。

**界面（虚拟组网分段的「面板自带」）**

1. **开启**：「开启」按钮。第一次开启会先下载 EasyTier，显示进度和失败原因。
2. **让手机加入**：Android 和 iPhone 两个标签，内容如上。
3. **扫码打开面板**：面板网址二维码。
4. **已加入的设备**：设备列表。
5. **高级选项**（`details.disclosure`）：自定义节点、是否使用社区共享节点、「重置网络名和密钥」。重置后所有设备都要重新加入，点击前提醒。

**类型与接口**

```ts
export interface PanelNetworkDevice {
  hostname: string;
  virtualIp: string | null;
  connection: 'direct' | 'relay' | 'unknown';
}

export interface PanelNetworkStatus {
  enabled: boolean;
  platformSupported: boolean;
  installed: boolean;
  state: 'stopped' | 'installing' | 'starting' | 'running' | 'error';
  detail: PanelMessage | null;
  virtualIp: string | null;           // 运行后为 10.127.0.1
  url: string | null;                 // http://10.127.0.1:<port>/
  devices: PanelNetworkDevice[];
  useSharedPeers: boolean;
  customPeers: string[];
}

export interface PanelNetworkJoinInfo {
  networkName: string;
  networkSecret: string;
  peers: string[];
  easytierVersion: string;            // EASYTIER_VERSION
  androidDownloadUrl: string;         // 钉死版本的 GitHub 发布页
}

export interface UpdatePanelNetworkRequest {
  enabled: boolean;
  useSharedPeers?: boolean;
  customPeers?: string[];             // 上限沿用 LAN_CUSTOM_PEER_LIMIT
}
```

`RemoteAccessStatus` 里不含密钥；密钥只在 `GET .../panel-network/join` 里返回（需要登录），前端只在「让手机加入」那一步请求。

## 6. 机房 / 云服务器场景

### 6.1 本期

目标是**打开就能用**：首次启动后，在自己电脑的浏览器里输入服务器地址就能打开面板，和竞品一样。

- **只用 SSH 登录的用户**：首次启动时问一句就能开启「直接访问」，见 6.3。
- **Windows 云服务器用户**：用远程桌面登录，服务器上有浏览器、本机能打开面板，在弹窗里开启即可。
- **开启后的默认值**：所有网卡、HTTPS（自签名证书）、不限来源。云服务器网卡上的私网地址也会被监听，公网来的连接能进来（3.2）。
- **不想看到证书警告时**：关掉 HTTPS（连接不再加密），或用 SSH 端口转发、虚拟组网（第 5 节）。
- **SSH 端口转发**：`ssh -L 3000:127.0.0.1:3000 用户@服务器`。不用写代码，只写进文档，给会用的人。
- **朋友进服**：走游戏端口直连，见 6.4。

**界面和终端都要提醒安全组**：「打不开？去云平台控制台的安全组放行 TCP <面板端口>。」这是云服务器上最常见的原因。

### 6.2 HTTPS（直接访问默认开启）：自签名证书

**监听**

- 开着 HTTPS 的每个监听器（直接访问默认开着，已装的组网软件可以手动开）按第一个字节分流（**原型已验证**）：
  - `0x16`（TLS 握手）：包成 `new tls.TLSSocket(raw, { isServer: true, secureContext })`，再交给 `app.server`。Fastify 看到的 `req.protocol` 是 `https`。
  - 其他（明文 HTTP）：交给一个只回跳转的小 HTTP 服务，返回 `308` 到 `https://<Host><原路径>`，然后关闭连接。`Host` 头只保留主机名和端口的合法字符。
- 连上后 10 秒内没发数据就断开。手动构造的 `TLSSocket` 不带 `tls.Server` 自带的握手超时，所以自己加一个计时器，10 秒内没完成握手就断开。
- TLS 版本用 Node 默认值（最低 TLS 1.2）。`TLSSocket` 出错时销毁底层连接。
- 不发 HSTS：浏览器对 IP 地址本来就忽略它；用域名访问时，它会让自签名证书的警告变成无法跳过。

**证书（`panel-certificate.ts`）**

- **生成时机**：第一次开启直接访问（HTTPS 默认开着）时在本机生成，不联网，之后一直复用。只有三种情况才重新生成：
  - 文件缺失或读不出；
  - 证书已过期，或 30 天内过期；
  - 用户点了「重新生成证书」。

  重新生成后指纹会变，浏览器要再确认一次，所以 `publicHost` 变化时不自动重新生成。
- **位置**：`<数据根>/tls/panel.key`、`<数据根>/tls/panel.crt`（PEM）。POSIX 上私钥文件权限设为 `0600`。私钥不进数据库、不进日志；数据目录本来就不提交。
- **算法**：ECDSA P-256 加 SHA-256（`crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' })`）。
- **证书内容**：
  - CN 为 `Mystry Dashboard`；
  - SAN 写入当时所有网卡的地址，以及 `publicHost`；
  - 扩展密钥用途含 `serverAuth`，`basicConstraints` 为 `CA:false`；
  - 有效期 800 天。苹果要求 TLS 服务器证书带 SAN、含 `serverAuth`、有效期不超过 825 天，否则 iOS / macOS 直接拒绝连接；这条是否适用于自签名证书，要真机确认。
- **生成方式**：Node 没有生成 X.509 证书的接口。本期自己写最小的 DER 编码：按固定结构拼出待签名内容，用 `crypto.sign('sha256', 待签名内容, 私钥)` 签名，估计约 150 行。
  - 测试用 `new crypto.X509Certificate()` 解析并逐项校验；CI 上有 `openssl` 时再交叉核对。
  - 不调用系统的 `openssl`（Windows Server 上不一定有），不加新依赖。
- **指纹**：用 `X509Certificate.fingerprint256`，终端和弹窗里都显示，想核对的用户可以和浏览器警告页里的证书比对。

**浏览器体验（未真机验证）**

- **电脑浏览器**：第一次显示「您的连接不是私密连接」，点「高级」→「继续前往」；之后一般会记住一段时间。
- **手机扫码**：同样先出警告页，iOS Safari 是「显示详细信息」→「访问此网站」。二维码旁写明这一步。
- **控制台**：`wss://` 和页面同源，跳过警告后应该能用。原型只用不校验证书的客户端验证过协议层。
- **关掉 HTTPS 的情况**：Chrome 154 起默认开启「始终使用安全连接」，第一次访问没有 HTTPS 的公网网站前会先弹提示，私网地址不受影响。Google 说的是 2026 年 10 月；有报道说 154 已发布正式版，但具体日期没能确认。所以关掉 HTTPS 后，Chrome 用户用公网 IP 打开也可能要点一次「继续」。界面说明里提一句。

**原型（Windows、Node 24，只在 `127.0.0.2` 上测过）**：额外监听器挂在和 `127.0.0.1` 相同的端口上，结果如下：
- HTTPS 请求返回 200，`req.protocol` 为 `https`；
- 明文 HTTP 返回 `308`，跳转到 `https://` 并保留了路径和查询参数；
- `wss://` 收发正常；
- 校验证书的客户端拒绝自签名证书（`DEPTH_ZERO_SELF_SIGNED_CERT`）；
- 关闭后不残留连接。

原型的证书是用 `openssl` 命令生成的，不是本节要写的 DER 编码。

### 6.3 启动器：首次启动问答与 `remote` 命令

`PanelManager.cmd`（经 `scripts/windows/panel-manager.ps1`）、`PanelManager.sh` 和便携包都把生命周期交给 `scripts/portable/mystryctl.mjs`（已核对），所以只改这一个文件。

**首次启动问答**

- **触发条件**（同时满足）：
  - 首次启动（`needsSetup`）；
  - 标准输入和输出都是终端；
  - 有 `SSH_CONNECTION` / `SSH_CLIENT` / `SSH_TTY` 之一。

  不用「没有图形界面」来猜，因为 WSL 和家里不接显示器的电脑也没有图形界面。用 `sudo` 运行时 SSH 变量可能被清掉，这时不提问，只打印提示行。`sudo` 下变量是否保留要实测。
- **问题**：「要让你自己的电脑或手机直接打开面板吗？[Y/n]」，直接回车等于是。
- **顺序**：
  1. 启动面板；
  2. 健康检查通过；
  3. `createInitialAdmin()`（已有）；
  4. 管理员建好后才提问；建失败时照现有逻辑提示手动创建，并补一句「之后运行 `<启动器> remote on`」；
  5. 选「是」时调用 `PUT /api/launcher/remote-access/direct`，请求体和界面默认值一样：所有网卡、HTTPS、不限来源；
  6. 成功就打印下面的信息块，账号密码块照旧；失败就打印原因和「运行 `<启动器> remote on` 重试」。
- **其他情况**：
  - 不提问的情况下，访问又没开时，只打印一行「要从其他电脑打开，运行 `<启动器> remote on`」；
  - 选了「否」的，以后不再问，检测到 SSH 时每次启动都打印这一行；
  - 远程登录时不尝试打开浏览器（现在的 `openBrowser()` 会在服务器上调用 `xdg-open`），改为打印可以从外面打开的网址。

**打印内容**（中英两份，用现有的 `text()`）：

```
面板已启动，可以在你自己的电脑或手机上打开：
  https://<地址>:<端口>
  · <地址> 是你 SSH 登录这台服务器时用的 IP 或域名（网卡上有公网地址、或填过公网地址时直接打印出来）
  · 浏览器第一次会提示「不安全」：点「高级」→「继续前往」。证书指纹（SHA-256）：<指纹>
  · 打不开：去云平台控制台的安全组放行 TCP <端口>；系统防火墙是 ufw 时再运行 sudo ufw allow <端口>/tcp
  · 不想看到警告：运行 <启动器> remote https off（连接不再加密）
```

关掉 HTTPS 时，网址改为 `http://`，去掉警告和指纹那一行，最后一行改为「想加密连接：运行 `<启动器> remote https on`」。

**命令**

| 命令 | 作用 |
|---|---|
| `remote on [网卡名]` | 开启直接访问，不写网卡名就是所有网卡；打印同上的信息块 |
| `remote off` | 关闭直接访问 |
| `remote status` | 显示是否开启、网址、安全选项、证书指纹和有效期、`problem` |
| `remote https on` / `remote https off` | 开关 HTTPS |
| `remote renew-cert` | 重新生成证书，打印新指纹 |

- 面板没运行时，除 `status` 外都提示「请先启动面板」，`status` 显示「未运行」。启动器不直接读写数据库。
- 用法同 `reset-password`：从配置里取 `LAUNCHER_TOKEN`，请求 `http://127.0.0.1:<port>/api/launcher/...`。
- `printHelp()` 的命令表加上 `remote`；运行中菜单 `RUNNING_MENU` 加一项「从其他设备访问」，进去后显示状态，并能开启或关闭。

### 6.4 玩家怎么进服：联机页「公网服务器」直连

前面几节讲的都是**管理面板**怎么打开。用户买带公网 IP 的服务器，是为了让朋友用「公网 IP:端口」直接进服。这条路游戏本身就支持，面板不拦，但联机页现在没有引导，还会把人引到错的地方。

**现状问题（已核对源码，未在真实云服务器上验证）**

- 很多云服务器（VPC 网络）的网卡上只有 `172.x` / `10.x` 私网地址，公网 IP 由云厂商在外面转发进来，服务器自己看不到。`describeLocalNetwork()` 只看网卡，会把私网地址列成「发给朋友的地址」，朋友拿去连不上；真正的公网 IP 页面上一个字都没有。
- 网卡上直接有公网 IPv4 的服务器：`listLanAddresses()` 会把它排在最后列出（`addressRank` 为 3），但上方说明写的是「朋友和这台电脑连着同一个 Wi-Fi 或路由器时用这个」，说法不对。
- `direct.elsewhere` 写「朋友不在身边？请用虚拟局域网，不需要自己有服务器」，等于劝已经买了服务器的人放弃最合适的方案。
- `direct.firewall` 只提 Windows 弹窗。云服务器上连不上，最常见的原因是安全组没放行，其次是 Linux 的 `ufw` / `firewalld`。
- 新手常把 `server-ip` 填成公网 IP。云服务器网卡上没有这个地址，游戏服务端绑定失败；现有 `serverIpBlocked` 文案说的是「同一网络的朋友连不上」，原因不对。

**做法**

1. **公网地址由用户填写**：IP 或域名，一台电脑一个值（同一台机器上所有实例共用，端口各自取 `server.properties`）。不自动探测：探测要请求第三方服务，结果在多网卡或代理下也不一定对。界面提示「在云平台控制台的实例详情里能看到公网 IP」。
2. **网卡上已有公网 IPv4 时直接显示**：按 3.2 的分类，`public` 网卡地址单独列在公网卡片里，不再混在「同一网络」的地址里。
3. **检查清单**（公网卡片里固定显示，`{port}` 为游戏端口，`{panelPort}` 为面板端口）：
   1. 在云平台的安全组（或防火墙）里放行 **TCP {port}** 的入方向，这是游戏端口。面板端口 {panelPort} 是另一回事，开启了「从其他设备访问」才需要放行。
   2. 系统防火墙：Windows 显示 `netsh` 放行命令的写法（或提示首次启动弹窗选「允许」）；Linux 显示 `sudo ufw allow {port}/tcp` 和 `firewalld` 的写法。系统类型优先复用本机节点已有的 `NodeHostInfo.platform`，实现时确认联机页能否拿到，拿不到再在响应里加字段。
   3. `server-ip` 留空。云服务器上不要填公网 IP。
   4. 可选：把域名的 A 记录指向公网 IP，服务器换 IP 时朋友不用改地址；游戏端口不是 25565 时，可以加 `_minecraft._tcp` SRV 记录，让朋友不用输端口（只写说明，面板不管 DNS）。
   5. 可选：开启白名单、保持 `online-mode=true`，不要对外开放 RCON 端口。
   6. 怎么确认能连：请不在同一网络的朋友试，或者用另一张网络（如手机热点）上的电脑试。云服务器能不能经自己的公网 IP 连回自己没验证过，所以不提供「在服务器上自己测」。

**共享类型与接口**

```ts
// packages/shared：InstanceLocalNetwork 增加字段
export interface InstanceLocalNetwork {
  port: number | null;
  /** 局域网 IPv4（不再包含公网地址） */
  addresses: string[];
  /** 新增：网卡上直接有的公网 IPv4 */
  publicIpv4: string[];
  publicIpv6: string[];
  /** 新增：用户填写的公网 IP 或域名；没填为 null */
  publicHost: string | null;
  serverIpBlocked: boolean;
  /** 新增：server-ip 填的正好是 publicHost，但网卡上没有这个地址（云服务器常见错误） */
  serverIpIsUnboundPublicHost: boolean;
  /** 新增：面板实际监听端口，用于区分游戏端口和面板端口的提醒。
   *  不能从浏览器地址栏取：经 SSH 端口转发打开时，本地端口可能和面板端口不同 */
  panelPort: number;
}

export interface UpdatePublicHostRequest {
  /** null 表示清除 */
  host: string | null;
}
```

- `schemas.ts`：`host` 为 `string`（`maxLength` 253）或 `null`。
- 路由：`PUT /api/system/public-host`（需要登录），返回 `{ publicHost }`。读取随 `GET /api/instances/:id/local-network` 和 `GET /api/system/remote-access` 返回。
- 校验（服务端）：
  - 先去掉首尾空白，再去掉用户顺手带上的 `http://`、`https://` 和末尾的 `/`；
  - 接受 IPv4、IPv6（不带方括号）或域名（字母、数字和连字符，至少一个点）；
  - 带端口时拒绝，返回 `server.publicHost.hasPort`（「端口不用填，会自动用服务器的游戏端口」）；
  - 带路径或其他字符时拒绝，返回 `server.publicHost.invalid`；
  - 私网、回环等地址**不拒绝**，前端在输入框下提示「这看起来是内网地址，外面的朋友可能连不上」；
  - 不解析域名、不发任何外部请求。
- 存储：`panel_settings` 的 `network.public_host`，联机页和面板网址共用。
- 前端：`api.ts` 增加 `updatePublicHost()`。

**`describeLocalNetwork()` 的改动**

- **不改** `listLanAddresses()` 的返回值和测试。在 `describeLocalNetwork()` 里用 3.2 的分类把结果拆成 `addresses`（`lan`）和 `publicIpv4`（`public`）。
- `server-ip` 判断改为在「局域网地址 + 网卡公网地址」里找：VPS 把 `server-ip` 填成自己网卡上的公网地址时，仍然算正常，只显示这一个地址。
- `server-ip` 等于 `publicHost` 且不在任何网卡上时，`serverIpBlocked` 和 `serverIpIsUnboundPublicHost` 都为 true，前端显示专门文案：「server-ip 填成了公网 IP。云服务器的网卡上没有这个地址，服务器可能启动失败或朋友连不上。请把它清空，然后重启服务器。」

**界面（`DirectSection.tsx`，按 `docs/design-system.md`）**

- 「同一网络」卡片保持现状；有 `publicIpv4` 或 `publicHost` 时，标题改为「同一网络里的设备用这个地址」，避免 `172.x` 被当成发给朋友的地址。
- **公网卡片**（`card form-card`，放在 IPv6 卡片前面）：
  - 有 `publicIpv4` 或 `publicHost` 时显示；都没有时，在页面底部的说明里放一个 `btn`「这台电脑有公网 IP（云服务器、机房）」，点开后显示填写框。
  - 内容：可复制的「地址:端口」列表（IPv6 加方括号）；`field` + `input` 填写公网 IP 或域名，「保存」为 `btn-primary`、「清除」为 `btn`；检查清单用有序列表。
  - 复制按钮用 4.4 的 `copyText()`。

**要改的现有文案**（en / zh-CN / zh-TW 三份都要改）

| 键 | 改成什么意思 |
|---|---|
| `multiplayer.direct.intro` | 朋友和这台电脑在同一个网络，或者这台电脑有公网 IP（云服务器、机房）时用这里 |
| `multiplayer.direct.addressTitle` | 有公网地址时显示上面的「同一网络」标题 |
| `multiplayer.direct.several` | 不再固定说「先试 192.168」；有公网卡片时不显示 |
| `multiplayer.direct.noAddress` | 去掉「连上 Wi-Fi」的假设，服务器上也能读懂 |
| `multiplayer.direct.firewall` | 拆成 Windows 弹窗一句；云安全组和 Linux 写进公网卡片的清单 |
| `multiplayer.direct.elsewhere`、`multiplayer.direct.ipv6.elsewhere` | 「朋友不在身边，这台电脑也没有公网 IP？用虚拟局域网」 |
| `multiplayer.direct.ipv6.router` | 补一句：云服务器上是安全组放行，不是路由器 |

新增键放在 `multiplayer.direct.public.*`；服务端错误放 `server.publicHost.*`。

### 6.5 下一期：Let's Encrypt IP 证书

Let's Encrypt 在 2026-01-15 正式开放 IP 地址证书（IPv4 和 IPv6），只能用「短期证书」档（`shortlived`），有效期 160 小时。有了它，不用域名也能做到 HTTPS 不报警告。计划做成 HTTPS 选项的升级：能申请到就用，申请不到退回 6.2 的自签名证书。本期不做，因为条件比较多：

- 安全组还要放行验证用的 80 或 443 端口；
- Linux 上监听 1024 以下端口需要 root 或 `CAP_NET_BIND_SERVICE`；
- 每隔几天必须全自动续期；
- 要实现 ACME 客户端（JWS 签名、订单、验证、提交 CSR），CSR 的编码可以复用 6.2。

**待核实**：IP 证书允许哪几种验证方式（官方公告没写，第三方资料说不支持 DNS 验证）；国内云服务器在没有备案时 80 / 443 端口是否会被拦截。

用户自己有域名和反向代理（Caddy 等）的，可以只出文档。但反向代理和面板在同一台机器上时，所有请求的 `req.ip` 都是 `127.0.0.1`：登录限流会把所有人算成同一个来源，`/api/health` 也会把进程指纹给代理后的所有人。写文档前要先处理。

## 7. 文档同步

- `docs/api.md`：
  - 3.4 的新接口；
  - `GET /api/instances/:id/local-network` 的新字段；
  - `GET /api/health` 对非回环请求不再返回 `processFingerprint`。
- `docs/configuration*.md`「安全建议」：现在写的是「**不要**将面板直接暴露到公网」（`configuration.zh-CN.md` 第 196 行，英文版同步）。改成说明：
  - 面板里可以开启从其他设备访问；
  - 安全选项各有什么用；
  - HTTPS 默认开启、浏览器警告怎么跳过、怎么关掉。
- `SECURITY.md`：
  - 第 32 行「默认监听 `127.0.0.1`」仍然成立；
  - 补充「从其他设备访问」和两个安全选项的说明；
  - 第 42 行说的是联机功能，不用改。
- `docs/ai/decisions.md`：D-023、D-024 的「不暴露面板」说的是联机功能，不用改。新增 D-033，记录：
  - 默认值参考竞品、安全做成可选开关；
  - 多挂监听器；
  - 登录即可开启；
  - 直接访问默认 HTTPS（自签名证书，同 Crafty），可关，Let's Encrypt 下一期；
  - 面板自带 EasyTier 用独立网络、无 TUN、只放行面板端口。
- `docs/user-guide*.md`、`docs/getting-started*.md`、`docs/portable-release.md`：
  - 新增「在其他设备上打开」；
  - 新增面板自带 EasyTier 的手机加入步骤；
  - 新增云服务器首次启动问答和 `remote` 命令；
  - SSH 端口转发作为备选。
- 联机相关用户指南：「朋友不在身边」按「有没有公网 IP」分两条路；写清游戏端口和面板端口的区别。
- `README.md` / `README.zh-CN.md`：快速开始里补一句怎么在手机和云服务器上打开。
- `docs/ai/current-state.md`、`CHANGELOG.md`。
- `docs/ai/project-facts.json`：如有接口清单字段要同步，然后跑 `knowledge:check`（它目前不检查 `docs/plans/`）。

## 8. 测试

**自动测试**

- **网卡分类**：
  - FlClash `198.18.0.1` → `proxy`；Tailscale `100.107.x.x/32` → `overlay`；`tailscale0` → `overlay`；
  - `mystry12 10.126.12.1` → `instanceNetwork`；WLAN `192.168.2.x/24` → `lan`；`eth0 203.0.113.10` → `public`；
  - 名字像组网但地址是公网段的网卡 → `overlay`；
  - 网址排序符合 3.2。
- **直接访问**：
  - 开启「所有网卡」时每个非回环地址都在监听；
  - 地址新增或消失后，重新枚举会补挂或关闭；
  - 选单块网卡时只监听它；
  - 任何类型的网卡都能选；「所有网卡」不含 `instanceNetwork` 地址；
  - 设置缺省、请求和启动器首次开启时 `https` 都为 true；
  - 一个地址监听失败时只标出它、其他照常；全部失败时返回 `listenFailed`，不写入开启状态；
  - 网卡不存在时面板照常启动。
- **只允许同一网段**：
  - 关闭时任何来源都放行；开启时网段内放行、网段外断开；
  - `::ffff:` 形式正确还原；`100.64.0.0/10` 规则；`/32` 非 CGNAT 网卡这一个地址不监听、标 `subnetUnknown`，其他网卡照常。
- **HTTPS 监听器**：
  - TLS 连接得到 `req.protocol === 'https'`；
  - 明文得到 `308`，跳到同主机 `https://` 加原路径，明文请求不会到达面板路由；
  - `Host` 头含非法字符时被清理；
  - 空连接和握手不完成的连接 10 秒后断开；
  - `wss://` 可用；关闭后连接全部断开；
  - 本机 `127.0.0.1` 监听器仍是 HTTP，不受影响。
- **证书**：
  - 能被 `crypto.X509Certificate` 解析；SAN、`serverAuth`、有效期 800 天符合 6.2；
  - 私钥文件在 POSIX 上为 `0600`；
  - 已有证书时复用，指纹不变；30 天内过期时重新生成；文件损坏时重新生成；
  - 私钥不出现在日志里；
  - 生成失败时返回 `certificateFailed`，用 `https: false` 重试能开启。
- **防火墙参数**：规则名；`localip` 和 `remoteip` 只在对应设置开启时出现；fallback；非 Windows 返回 `skipped`。
- **面板自带 EasyTier**：
  - 生成的 `core.toml`：`tcp_whitelist` 只有面板端口，`no_tun`、`private_mode` 为 true，地址 `10.127.0.1`；
  - 密钥在 `panel_settings` 和 `core.toml` 里，不在命令行参数和日志里；
  - 连接落在回环时（取决于原型）：从组网访问 launcher 接口缺 `LAUNCHER_TOKEN` 被拒；从组网访问本机其他只监听回环的端口连不上；
  - 网络名和密钥的格式；重置后两者都变；
  - 用 `easytier-cli` 的 JSON 样例解析出设备列表；
  - Windows 安装时解压 `Packet.dll`，`lanInstalled()` 也检查它（附 B）；
  - 进程退出后状态为 `error`；面板启动时按设置自动启动；关闭时停止；
  - `GET .../join` 未登录返回 401；`RemoteAccessStatus` 里没有密钥。
- **路由**：
  - 未登录返回 401；已登录的非回环请求可以开启和关闭；
  - 开启和关闭都写日志，日志里没有密钥、令牌和私钥；
  - `/api/launcher/remote-access*` 缺 `LAUNCHER_TOKEN` 或非回环时被拒；从额外监听器（含 HTTPS）访问 launcher 接口被拒；
  - `GET /api/health` 对回环请求带 `processFingerprint`，非回环不带（`security-self-test.ts` 现有断言走回环，确认不受影响）。
- **公网直连（6.4）**：
  - `describeLocalNetwork` 的断言补上 `publicIpv4`、`publicHost`、`serverIpIsUnboundPublicHost`、`panelPort`；`listLanAddresses` 的现有测试不改；
  - 网卡上有 `203.0.113.10` 时进 `publicIpv4`，不在 `addresses`；
  - `server-ip` 填网卡上的公网地址时，`serverIpBlocked` 为 false，只返回这一个地址（防回归）；
  - `server-ip` 等于 `publicHost` 且不在网卡上时，两个标志都为 true；
  - 公网地址校验：IPv4、IPv6、域名通过；`http://` 前缀和末尾 `/` 被去掉；带端口、带路径、超长、空字符串被拒；私网地址通过；`null` 清除。
- **启动器（`portable.test.mjs`）**：
  - SSH 环境变量的判断；非终端时不提问；
  - 创建管理员失败时不提问、不开启；开启失败时打印原因和重试命令；
  - `remote` 各子命令在面板未运行时的提示；
  - 打印块里的网址拼法（公网网卡、`publicHost`、都没有时的占位说明）；开着 HTTPS 时用 `https://` 并带指纹，关掉时用 `http://`、不带指纹。
- **二维码**：固定网址生成矩阵，断言尺寸、三个定位角、结果稳定。
- **前端**：`npm.cmd run typecheck`（三语键一致）。

## 9. 人工验证（必须）

- **真机，同一个 Wi-Fi**：用默认值开启直接访问，扫码后跳过证书警告、登录、看控制台、复制地址；开「只允许同一网段」后，用流量的手机打不开。
- **真机，用流量，面板自带 EasyTier**：
  - Android 装 `2.6.4`，用加入信息二维码复制网络名和密钥，加入后扫码打开面板；
  - 设备列表里能看到手机；
  - Windows 上面板不以管理员身份运行时也能用（本机原型已通过，真机再确认一次）；首次开启时的防火墙弹窗和提示。
- **真机，用流量，经 Tailscale**：扫码打开面板。
- **HTTPS（默认开启）**：
  - Chrome、Edge、Firefox 的警告页能跳过；iPhone Safari 和 Android Chrome 能跳过并登录；
  - 关掉 HTTPS 后 `http://` 能直接打开；
  - 800 天有效期的自签名证书在 iOS 上不被直接拒绝；
  - 浏览器记住证书例外的时长；重新生成证书后需要再确认一次。
- **Linux 云服务器（SSH 登录）**：
  - `ip addr` 看网卡上是公网还是私网地址；
  - 首次启动出现问答，选「是」后打印网址；用 `sudo` 运行时只打印提示行，照着 `remote on` 也能开启；
  - 安全组放行前打不开、放行后能打开；
  - 输入 `http://` 会跳到 `https://`；`remote https off` 后 `http://` 能直接打开；
  - 登录、控制台、上传下载文件都正常；`remote off` 后远程会话立即断开。
- **Windows 云服务器（远程桌面）**：在弹窗里开启；`netsh` 规则加不上时的提示。
- **防火墙**：非管理员运行面板时的防火墙弹窗和失败提示。
- **联机页**：
  - 云服务器（VPC）填公网 IP；安全组不放行时朋友连不上，放行游戏端口后能连；
  - `server-ip` 填公网 IP 时出现专门提示；
  - 网卡上直接有公网 IP 的 VPS，公网卡片自动出现；
  - Windows Server 上首次启动 Java 是否会弹防火墙窗口。
- **其他**：
  - 换 Wi-Fi 后「所有网卡」自动跟上新地址；
  - 便携包流程（`mystryctl` 仍按 `HOST` 连回环）；
  - 窄屏下的弹窗布局和「本机」页入口。

## 10. 未验证与剩余风险

**未验证**

- **监听器原型**：只在 `127.0.0.2` 上测过，没在真实网卡和真机上测；来源检查没写进原型。
- **Linux 上的通配监听**：`0.0.0.0` 和 `127.0.0.1` 同端口共存，本机 Windows 实测可以；Linux 没测（本机 WSL 起不来），设计按「每个地址各挂一个」写。
- **HTTPS 原型**：只验证了协议层；自写 DER 编码还没写；没在真实浏览器和手机上走过警告页；苹果的证书要求是否适用于自签名证书没核实；手动 `TLSSocket` 没有握手超时这一点没写测试验证。
- **EasyTier**：
  - 无 TUN 原型只在本机两个节点之间、经回环测过（5.3「原型结果」）：第 1–4 点在这个条件下成立；跨网络、经社区节点中转的真实情况没测；
  - 第 5 点（Android 导入配置）和第 6 点（真实 WireGuard 客户端连接）没测；
  - iOS 没有确认来源的官方客户端；
  - WireGuard 入口的配置方法未核实。
- **网卡和防火墙**：
  - Tailscale 网卡 `/32` 掩码只在这一台 Windows 电脑上见过；
  - 非管理员下 `netsh` 的失败方式、Windows 防火墙弹窗是否一定出现都没实测。
- **云服务器和启动器**：
  - 云服务器网卡上是私网地址，这一前提来自通用经验；
  - `sudo` 下 SSH 变量是否保留、`openBrowser()` 在无图形界面服务器上的行为没测。
- **二维码库**：`qrcode-generator@2.0.4` 打包后的实际体积没量。

**剩余风险**

- **默认 HTTPS 用自签名证书**（和 Crafty 一样）：
  - 每台设备第一次打开都要点过浏览器警告，小白可能被「不安全」吓到，只能靠界面和终端的说明；
  - 防不住主动的中间人冒充，只能靠核对指纹；下一期的 Let's Encrypt IP 证书才能解决。
- **用户关掉 HTTPS 时**：在同一网络或公网上抓包的人能看到密码和令牌。这是用户自己的选择，界面说明一句，不拦。
- **默认不限来源，登录页可能面向公网**（和竞品一样）：保护是登录本身，包括首个管理员的随机密码、至少 12 位的密码要求，以及按「来源 IP + 用户名」的失败限流（换很多 IP 试同一个账号时没有按账号的上限）。后续安全审计要把不需要登录的接口放在最前面。
- **面板自带 EasyTier**：
  - 依赖社区共享节点发现和中转，节点随时可能下线，用户可以加自己的节点；
  - Android 安装包在 GitHub 上，国内下载可能慢；
  - 无 TUN 模式下组网里的请求在面板看来都来自 `127.0.0.1`。
- **用户可能搞混端口**：联机页的游戏端口和面板端口，只能靠清单里的说明区分；面板读不到云平台的安全组。
- **公网分类按地址段判断**：个别公司或机房内网用非标准地址段时，会被当成公网地址。只影响说明文字和排序，不影响功能。
- **本机反向代理**：反向代理和面板在同一台机器上时，`req.ip` 都是 `127.0.0.1`，launcher 接口会对代理后的所有人开放（仍需 `LAUNCHER_TOKEN`）。这个问题现在就存在，不是新引入的。

## 附 A：代理虚拟网卡对联机页有没有用

作为地址没用。`198.18.x.x` 是 FlClash、Clash 这类代理软件 TUN 模式的虚拟地址，只存在于这台电脑上，朋友的电脑路由不到。`local-network-service.ts` 已经过滤掉了。

## 附 B：顺带发现的现有问题

- **（已实测）实例联机在 Windows 上可能根本起不来**：`lan-runtime.ts` 安装 EasyTier 时只解压 `easytier-core.exe`、`easytier-cli.exe` 和 `wintun.dll`。但 2.6.4 的 `easytier-core.exe` 一启动就要加载同一压缩包里的 `Packet.dll`，没有它时退出码为 `0xC0000135`（找不到 DLL）。本机 `System32` 和 `System32\Npcap` 下都没有 `Packet.dll`，实测连 `--version` 都跑不起来。没装 Npcap（或没开 WinPcap 兼容模式）的 Windows 电脑应该都会这样。修法：把 `Packet.dll` 加进 Windows 的 `extraNames`；`lanInstalled()` 会因此认为旧安装不完整，自动重新安装。仓库里搜不到 `Packet.dll`，现有测试也没覆盖到真实启动。
- （未实测）`listLanAddresses()` 第 48 行在所有网卡都被认成虚拟网卡时退回不过滤，联机页可能把 `198.18.x.x` 当加入地址显示。
- （未实测）虚拟网卡正则和网段判断里没有面板自己的实例网卡（名字 `mystry<数字>`、地址 `10.126.x.1`），实例的虚拟局域网运行时，联机页「同一网络」可能把 `10.126.x.1` 当局域网地址列出。需要开着一个实例的虚拟局域网实测确认网卡名；本期实现网卡分类时一并修正。

## 附 C：竞品参考（公开文档，未实际安装）

| 产品 | 怎么从别的设备打开 | 加密和安全选项 |
|---|---|---|
| MCSManager | 手动安装文档要求放行 23333 和 24444 端口，用「IP:端口」直接访问 | 默认 HTTP；官方建议普通用户不要配 HTTPS（浏览器要直连每个节点，每个都得单独反代） |
| PufferPanel | 默认监听 `0.0.0.0:8080` | 不支持 TLS，文档教用 nginx 反代 |
| Crafty | 用本机 IP 就能访问 | 只走 HTTPS，自带自签名证书 |
| 1Panel | 安装结束打印外网和内网地址，网址带随机「安全入口」路径 | 可选：面板 SSL（自签名）、授权 IP、两步验证 |
| AMP | 安装脚本自动配 nginx 和 Let's Encrypt | 内置 HTTPS 官方不推荐 |

本设计取的是：开启后像 MCSManager、PufferPanel 一样直接用「IP:端口」打开；像 Crafty 一样默认 HTTPS、自带自签名证书；安全选项像 1Panel 一样可开可关；终端打印网址学 1Panel；Let's Encrypt 学 AMP，放下一期。
