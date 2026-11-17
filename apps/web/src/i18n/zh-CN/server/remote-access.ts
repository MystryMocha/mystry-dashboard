import type { REMOTE_ACCESS_MESSAGES } from '@mystry/shared';

/** 服务端消息（从其他设备访问、面板自带网络、公网地址）的简体中文翻译；英文模板在 packages/shared/src/messages/remote-access.ts。 */
export default {
  'server.remoteAccess.invalidRequest': '访问设置的格式不正确',
  'server.remoteAccess.managedByConfig': '访问方式由配置文件里的 HOST 决定，不能在这里修改',
  'server.remoteAccess.interfaceRequired': '请先选择一块网卡',
  'server.remoteAccess.interfaceGone': '网卡「{name}」不在了，请重新选择',
  'server.remoteAccess.noAddress': '这台电脑没有其他设备能连到的网络地址',
  'server.remoteAccess.listenFailed': '面板没能在任何地址上监听。{port} 端口可能被别的程序占用',
  'server.remoteAccess.certificateFailed': 'HTTPS 证书生成或读取失败',
  'server.remoteAccess.launcherUnavailable': '面板正在启动或关闭，暂时不能修改访问方式',
  'server.panelNetwork.invalidRequest': '面板网络设置的格式不正确',
  'server.panelNetwork.unsupportedPlatform': '这个系统上不能使用面板自带的网络',
  'server.panelNetwork.notEnabled': '请先开启面板自带的网络',
  'server.panelNetwork.tooManyPeers': '最多添加 {max} 个自定义节点',
  'server.panelNetwork.noPeers': '至少填写一个节点，或者保留社区共享节点',
  'server.panelNetwork.startFailed': 'EasyTier 启动失败',
  'server.panelNetwork.exited': 'EasyTier 意外停止。请关闭后重新开启面板自带的网络',
  'server.publicHost.invalid': '请填写公网 IP 或域名，例如 203.0.113.10 或 mc.example.com',
  'server.publicHost.hasPort': '端口不用填，会自动用服务器的游戏端口',
} satisfies Record<keyof typeof REMOTE_ACCESS_MESSAGES, string>;
