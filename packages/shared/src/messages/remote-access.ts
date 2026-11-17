/** 服务端返回给用户的消息：从其他设备访问面板、面板自带网络和公网地址。值为英文模板，`{name}` 为参数占位；其他语言由 Web 文案表按键翻译。 */
export const REMOTE_ACCESS_MESSAGES = {
  'server.remoteAccess.invalidRequest': 'The access settings are malformed.',
  'server.remoteAccess.managedByConfig': 'Access is set by HOST in the configuration file, so it cannot be changed here.',
  'server.remoteAccess.interfaceRequired': 'Choose a network adapter first.',
  'server.remoteAccess.interfaceGone': 'The network adapter "{name}" is no longer available. Choose another one.',
  'server.remoteAccess.noAddress': 'This computer has no network address that other devices can reach.',
  'server.remoteAccess.listenFailed': "The panel couldn't start listening on any address. Port {port} may be in use by another program.",
  'server.remoteAccess.certificateFailed': "The HTTPS certificate couldn't be created or read.",
  'server.remoteAccess.launcherUnavailable': 'Access cannot be changed while the panel is starting or shutting down.',

  'server.panelNetwork.invalidRequest': 'The panel network settings are malformed.',
  'server.panelNetwork.unsupportedPlatform': "The panel's built-in network is not available on this system.",
  'server.panelNetwork.notEnabled': 'Turn on the built-in network first.',
  'server.panelNetwork.tooManyPeers': 'You can add up to {max} custom nodes.',
  'server.panelNetwork.noPeers': 'Add at least one node, or keep the community shared nodes on.',
  'server.panelNetwork.startFailed': "EasyTier couldn't be started.",
  'server.panelNetwork.exited': 'EasyTier stopped unexpectedly. Turn the built-in network off and on again.',

  'server.publicHost.invalid': 'Enter a public IP address or a domain name, such as 203.0.113.10 or mc.example.com.',
  'server.publicHost.hasPort': "Leave out the port. The server's game port is added automatically.",
} as const satisfies Record<string, string>;
