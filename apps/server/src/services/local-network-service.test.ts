import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.JWT_SECRET = 'a'.repeat(64);
process.env.SETUP_TOKEN = 'b'.repeat(64);
process.env.LAUNCHER_TOKEN = 'c'.repeat(64);

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mystry-local-network-test-'));
process.env.MYSTRY_HOME = dataRoot;
process.env.MYSTRY_DATA_DIR = dataRoot;
test.after(() => fs.rmSync(dataRoot, { recursive: true, force: true }));

function ipv6(address: string, internal = false): os.NetworkInterfaceInfo {
  return {
    address,
    netmask: 'ffff:ffff:ffff:ffff::',
    family: 'IPv6',
    mac: '00:00:00:00:00:00',
    internal,
    cidr: `${address}/64`,
    scopeid: 0,
  };
}

function ipv4(address: string, internal = false): os.NetworkInterfaceInfo {
  return {
    address,
    netmask: '255.255.255.0',
    family: 'IPv4',
    mac: '00:00:00:00:00:00',
    internal,
    cidr: `${address}/24`,
  };
}

test('只列出局域网 IPv4，并把常见家用网段排在前面', async () => {
  const { listLanAddresses } = await import('./local-network-service.js');
  const addresses = listLanAddresses({
    lo: [ipv4('127.0.0.1', true)],
    vpn: [ipv4('10.126.126.5')],
    wifi: [
      ipv4('192.168.1.23'),
      { address: 'fe80::1', netmask: 'ffff:ffff:ffff:ffff::', family: 'IPv6', mac: '00:00:00:00:00:00', internal: false, cidr: 'fe80::1/64', scopeid: 1 },
    ],
    unplugged: [ipv4('169.254.10.20')],
    duplicate: [ipv4('192.168.1.23')],
    empty: undefined,
  });
  assert.deepEqual(addresses, ['192.168.1.23', '10.126.126.5']);
});

test('认得出的虚拟网卡不列出；只剩虚拟网卡时照常列出', async () => {
  const { listLanAddresses } = await import('./local-network-service.js');
  assert.deepEqual(
    listLanAddresses({
      WLAN: [ipv4('192.168.2.124')],
      'vEthernet (WSL (Hyper-V firewall))': [ipv4('172.30.208.1')],
      Tailscale: [ipv4('100.111.126.124')],
      Meta: [ipv4('198.18.0.1')],
      'VMware Network Adapter VMnet8': [ipv4('192.168.80.1')],
    }),
    ['192.168.2.124'],
  );
  assert.deepEqual(listLanAddresses({ 'unnamed-overlay': [ipv4('100.64.0.9')] }), ['100.64.0.9']);
});

test('地址很多时只保留前几个', async () => {
  const { listLanAddresses } = await import('./local-network-service.js');
  const many = Object.fromEntries(
    Array.from({ length: 12 }, (_unused, index) => [`eth${index}`, [ipv4(`192.168.${index}.2`)]]),
  );
  const addresses = listLanAddresses(many);
  assert.equal(addresses.length, 6);
  assert.equal(addresses[0], '192.168.0.2');
});

test('只列出实体网卡上的公网 IPv6 地址', async () => {
  const { listPublicIpv6Addresses } = await import('./local-network-service.js');
  assert.deepEqual(
    listPublicIpv6Addresses({
      lo: [ipv6('::1', true)],
      WLAN: [
        ipv4('192.168.2.124'),
        ipv6('fe80::1234'),
        ipv6('fd12:3456::1'),
        ipv6('2408:8207:AB::10'),
        ipv6('2408:8207:ab::10'),
        ipv6('2002:c000:204::1'),
        ipv6('2001:0:4136:e378::1'),
        ipv6('2001:db8::1'),
      ],
      Tailscale: [ipv6('2a01:4f8::1'), ipv6('fd7a:115c:a1e0::1')],
      empty: undefined,
    }),
    ['2408:8207:ab::10'],
  );
  const many = { eth0: Array.from({ length: 8 }, (_unused, index) => ipv6(`240e:1::${index + 1}`)) };
  assert.equal(listPublicIpv6Addresses(many).length, 3);
});

test('server-ip 决定是否给出公网 IPv6：留空给出，0.0.0.0 或具体地址不给', async (t) => {
  const { describeLocalNetwork } = await import('./local-network-service.js');
  const { initDb, closeDb } = await import('../db.js');
  const { createInstance } = await import('./instance-service.js');
  const { writeServerProperties } = await import('./config-service.js');
  const { config } = await import('../config.js');
  initDb();
  t.after(() => closeDb());
  const instanceId = createInstance({ name: 'Alpha', acceptEula: true }).id;
  const interfaces = { WLAN: [ipv4('192.168.1.23'), ipv6('2408:8207:ab::10')] };
  const write = (serverIp: string) =>
    writeServerProperties(instanceId, { 'server-port': '25570', 'server-ip': serverIp });

  // Fields present in every response: no public address set, the panel port and the OS type.
  const common = {
    publicHost: null,
    serverIpIsUnboundPublicHost: false,
    panelPort: config.port,
    platform: process.platform,
  };
  write('');
  assert.deepEqual(describeLocalNetwork(instanceId, interfaces), {
    ...common,
    port: 25570,
    addresses: ['192.168.1.23'],
    publicIpv4: [],
    publicIpv6: ['2408:8207:ab::10'],
    serverIpBlocked: false,
  });
  write('0.0.0.0');
  assert.deepEqual(describeLocalNetwork(instanceId, interfaces).publicIpv6, []);
  assert.deepEqual(describeLocalNetwork(instanceId, interfaces).addresses, ['192.168.1.23']);
  write('192.168.1.23');
  assert.deepEqual(describeLocalNetwork(instanceId, interfaces).publicIpv6, []);
  write('203.0.113.9');
  assert.deepEqual(describeLocalNetwork(instanceId, interfaces), {
    ...common,
    port: 25570,
    addresses: [],
    publicIpv4: [],
    publicIpv6: [],
    serverIpBlocked: true,
  });

  // With the port left empty the game uses 25565; it is null only when something is written that is not a port number.
  writeServerProperties(instanceId, { 'server-port': '', 'server-ip': '' });
  assert.equal(describeLocalNetwork(instanceId, interfaces).port, 25565);
  writeServerProperties(instanceId, { 'server-port': 'abc', 'server-ip': '' });
  assert.equal(describeLocalNetwork(instanceId, interfaces).port, null);
});
