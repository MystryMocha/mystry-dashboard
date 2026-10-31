import type { FRP_MESSAGES } from '@mystry/shared';

/** 服务端消息（frp）的简体中文翻译；英文模板在 packages/shared/src/messages/frp.ts。 */
export default {
  'server.frp.invalidParams': '联机设置包含不支持的字段或格式不正确',
  'server.frp.endpointNotFound': '找不到这个穿透服务器',
  'server.frp.endpointInUse': '还有实例在使用这个穿透服务器，请先关闭那个实例的联机',
  'server.frp.endpointNameRequired': '穿透服务器名称不能为空',
  'server.frp.hostInvalid': '请填写主机名或 IP 地址，不要带协议、路径或端口',
  'server.frp.tokenRequired': '需要填写穿透令牌',
  'server.frp.tokenInvalid': '穿透令牌包含无法保存的字符',
  'server.frp.remotePortRequired': '请选择朋友要连接的公网端口',
  'server.frp.remotePortInUse': '这个穿透服务器上的另一个实例已经使用了该公网端口',
  'server.frp.instanceNotFound': '实例不存在',
  'server.frp.serverIpBlocked': '请先清空 server.properties 里的 server-ip。游戏必须在这台电脑上接受连接，不能只监听某个局域网地址',
  'server.frp.localPortIsPanel': '游戏端口和面板端口相同。开放联机前请先修改 server-port',
  'server.frp.localPortInvalid': 'server.properties 里的游戏端口不是有效端口',
  'server.frp.clientMissing': '尚未安装官方 frp 客户端',
  'server.frp.platformUnsupported': '这个操作系统没有钉死版本的官方 frp 客户端',
  'server.frp.downloadFailed': '官方 frp 客户端下载失败',
  'server.frp.checksumMismatch': '下载的 frp 客户端与钉死的校验和不一致，已丢弃',
  'server.frp.extractFailed': '官方 frp 客户端压缩包无法解包',
  'server.frp.notRunning': '请先启动实例再开放隧道。只有游戏在运行时朋友才能连接',
  'server.frp.startFailed': '隧道客户端启动失败',
  'server.frp.loginFailed': '隧道客户端登录失败。请检查地址、端口、令牌、传输协议和 TLS 设置',
  'server.frp.proxyFailed': '穿透服务器拒绝了游戏隧道。公网端口可能已被占用',
  'server.frp.exited': '隧道客户端已退出。游戏运行后再次保存联机设置即可重试',
  'server.frp.visitorUnavailable': '下载朋友配置前，需要先使用内网隧道',
} satisfies Record<keyof typeof FRP_MESSAGES, string>;
