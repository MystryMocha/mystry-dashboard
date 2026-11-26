import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeIoRates,
  createIoRateSampler,
  parseProcDiskstats,
  parseProcNetDev,
  parseWindowsIoCounters,
  readIoCounters,
  readWindowsIoCounters,
  selectLinuxDisks,
  selectLinuxInterfaces,
  type IoCounterSnapshot,
} from './io-counters.js';

const PROC_NET_DEV = `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 5000000   40000    0    0    0     0          0         0  5000000   40000    0    0    0     0       0          0
  eth0: 123456789  98765    0    0    0     0          0         0 98765432   54321    0    0    0     0       0          0
docker0:  700000    3000    0    0    0     0          0         0   800000    2000    0    0    0     0       0          0
vethab12: 690000    2900    0    0    0     0          0         0   790000    1900    0    0    0     0       0          0
`;

const PROC_DISKSTATS = `   7       0 loop0 120 0 2400 10 0 0 0 0 0 20 10 0 0 0 0
   8       0 sda 10000 200 400000 5000 8000 300 160000 9000 0 12000 14000 0 0 0 0
   8       1 sda1 9000 180 360000 4500 7900 290 158000 8900 0 11000 13400 0 0 0 0
 259       0 nvme0n1 50000 0 1000000 20000 30000 0 600000 15000 0 30000 35000 0 0 0 0
 259       1 nvme0n1p1 49000 0 990000 19800 29900 0 599000 14900 0 29800 34700 0 0 0 0
 253       0 dm-0 48000 0 980000 19000 29000 0 590000 14000 0 29000 33000 0 0 0 0
`;

test('/proc/net/dev is parsed into received and transmitted bytes per interface', () => {
  const counters = parseProcNetDev(PROC_NET_DEV);
  assert.deepEqual(counters.get('eth0'), { rxBytes: 123456789, txBytes: 98765432 });
  assert.deepEqual(counters.get('docker0'), { rxBytes: 700000, txBytes: 800000 });
  assert.equal(counters.has('face |bytes'), false, 'header lines are skipped');
  assert.equal(counters.size, 4);
});

test('Linux interfaces keep device-backed NICs, and fall back to everything except loopback inside a container', () => {
  const all = parseProcNetDev(PROC_NET_DEV);
  assert.deepEqual([...selectLinuxInterfaces(all, new Set(['eth0'])).keys()], ['eth0'], 'bridge and veth traffic is not counted twice');
  assert.deepEqual([...selectLinuxInterfaces(all, new Set()).keys()], ['eth0', 'docker0', 'vethab12']);
});

test('/proc/diskstats sectors are converted at 512 bytes and only whole physical disks are kept', () => {
  const all = parseProcDiskstats(PROC_DISKSTATS);
  assert.deepEqual(all.get('sda'), { readBytes: 400000 * 512, writeBytes: 160000 * 512 });
  assert.equal(all.size, 6);

  const fromSysfs = selectLinuxDisks(all, new Set(['sda', 'nvme0n1']));
  assert.deepEqual([...fromSysfs.keys()], ['sda', 'nvme0n1'], 'partitions, loop and device-mapper are left out');
  assert.deepEqual([...selectLinuxDisks(all, null).keys()], ['sda', 'nvme0n1'], 'the name pattern stands in when sysfs is unreadable');
  assert.deepEqual([...selectLinuxDisks(all, new Set(['loop0', 'dm-0'])).keys()], ['loop0', 'dm-0']);

  const cciss = parseProcDiskstats(' 104 0 cciss/c0d0 10 0 20 0 10 0 40 0 0 0 0\n');
  assert.deepEqual([...selectLinuxDisks(cciss, new Set(['cciss!c0d0'])).keys()], ['cciss/c0d0']);
});

test('Windows counters keep hardware adapters keyed by DeviceID, with fallbacks for VMs and failed queries', () => {
  const stdout = JSON.stringify({
    disks: [
      { id: '0 C:', read: 1000, write: 2000 },
      { id: '1 D:', read: 30, write: 40 },
    ],
    nets: [
      { id: '{WLAN}', hardware: true, virtual: false, rx: 5000, tx: 600 },
      { id: '{TUN}', hardware: false, virtual: true, rx: 4900, tx: 590 },
      { id: '{ETH}', hardware: true, virtual: false, rx: 0, tx: 0 },
    ],
  });
  const snapshot = parseWindowsIoCounters(stdout);
  assert.deepEqual([...snapshot.disks!.keys()], ['0 C:', '1 D:']);
  assert.deepEqual([...snapshot.network!.keys()], ['{WLAN}', '{ETH}'], 'a proxy TUN carrying the same traffic is not added on top');

  const vm = parseWindowsIoCounters(JSON.stringify({
    disks: { id: '0 C:', read: 1, write: 2 },
    nets: [
      { id: '{SYNTH}', hardware: false, virtual: false, rx: 10, tx: 20 },
      { id: '{VPN}', hardware: false, virtual: true, rx: 9, tx: 19 },
    ],
  }));
  assert.deepEqual([...vm.disks!.keys()], ['0 C:'], 'a single object from ConvertTo-Json is read as a one-item list');
  assert.deepEqual([...vm.network!.keys()], ['{SYNTH}'], 'without hardware adapters the non-virtual ones are used');

  const failed = parseWindowsIoCounters(JSON.stringify({ disks: null, nets: [] }));
  assert.equal(failed.disks, null, 'a failed CIM query stays unknown rather than zero');
  assert.equal(failed.network!.size, 0);
});

function snapshot(net: Record<string, [number, number]>, disks: Record<string, [number, number]>): IoCounterSnapshot {
  return {
    network: new Map(Object.entries(net).map(([id, [rxBytes, txBytes]]) => [id, { rxBytes, txBytes }])),
    disks: new Map(Object.entries(disks).map(([id, [readBytes, writeBytes]]) => [id, { readBytes, writeBytes }])),
  };
}

test('rates sum per-device deltas and skip devices that appeared, vanished or reset', () => {
  const before = snapshot({ a: [1000, 100], b: [5000, 500], gone: [1, 1] }, { sda: [0, 0] });
  const after = snapshot({ a: [11000, 1100], b: [10, 10], added: [9999, 9999] }, { sda: [2048, 4096] });
  const rates = computeIoRates(before, after, 10_000);
  assert.equal(rates.netRxBytesPerSec, 1000, 'b reset its counter and is skipped instead of going negative');
  assert.equal(rates.netTxBytesPerSec, 100);
  assert.equal(rates.diskReadBytesPerSec, 204.8);
  assert.equal(rates.diskWriteBytesPerSec, 409.6);

  const unknown = computeIoRates({ network: null, disks: null }, after, 10_000);
  assert.equal(unknown.netRxBytesPerSec, null);
  assert.equal(unknown.diskReadBytesPerSec, null);
  assert.equal(computeIoRates(snapshot({ x: [1, 1] }, {}), snapshot({ y: [2, 2] }, {}), 10_000).netRxBytesPerSec, null);
});

test('the sampler needs a baseline, re-baselines after a long gap, and ignores reads that finish after reset', async () => {
  let clock = 0;
  let counter = 0;
  const gate: { hold: boolean; release?: () => void } = { hold: false };
  const sampler = createIoRateSampler({
    now: () => clock,
    read: async () => {
      if (gate.hold) await new Promise<void>((resolve) => { gate.release = resolve; });
      return snapshot({ nic: [counter, counter] }, { disk: [counter * 2, counter] });
    },
  });

  assert.equal((await sampler.sample(600_000)).netRxBytesPerSec, null, 'the first read only sets the baseline');

  clock += 300_000;
  counter += 300_000;
  const rates = await sampler.sample(600_000);
  assert.equal(rates.netRxBytesPerSec, 1000);
  assert.equal(rates.diskReadBytesPerSec, 2000);

  clock += 3_600_000;
  counter += 60;
  assert.equal((await sampler.sample(600_000)).netRxBytesPerSec, null, 'an hour-long gap is not averaged over');
  clock += 300_000;
  counter += 3_000;
  assert.equal((await sampler.sample(600_000)).netRxBytesPerSec, 10, 'the read after the gap became the new baseline');

  gate.hold = true;
  const inFlight = sampler.sample(600_000);
  await new Promise((resolve) => setImmediate(resolve));
  sampler.reset();
  gate.release!();
  assert.equal((await inFlight).netRxBytesPerSec, null);
  gate.hold = false;
  clock += 300_000;
  assert.equal((await sampler.sample(600_000)).netRxBytesPerSec, null, 'reset left no baseline behind');

  const failing = createIoRateSampler({ read: () => Promise.reject(new Error('timeout')) });
  await failing.prime();
  assert.equal((await failing.sample(600_000)).diskWriteBytesPerSec, null);
});

test('real counters on this platform are readable', { skip: !['win32', 'linux'].includes(process.platform) }, async () => {
  // Same reasoning as the readProcesses check in metrics-service.test.ts: this checks the query, not its speed.
  // A GitHub Windows runner takes 2–3.5 s just to start PowerShell, and the first WMI query adds a cold start.
  // Device counts are not asserted: a CI VM may expose no device the filters treat as physical.
  const counters = process.platform === 'win32' ? await readWindowsIoCounters(45_000) : await readIoCounters();
  assert.ok(counters.disks, 'disk counters are readable');
  assert.ok(counters.network, 'network counters are readable');
  for (const value of counters.disks.values()) {
    assert.ok(value.readBytes >= 0 && value.writeBytes >= 0);
  }
});
