import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.JWT_SECRET = 'a'.repeat(64);
process.env.SETUP_TOKEN = 'b'.repeat(64);
process.env.LAUNCHER_TOKEN = 'c'.repeat(64);

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mystry-local-network-test-'));
process.env.MYSTRY_DATA_DIR = dataRoot;
test.after(() => fs.rmSync(dataRoot, { recursive: true, force: true }));

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
