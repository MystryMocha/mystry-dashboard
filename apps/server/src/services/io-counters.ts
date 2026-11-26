import path from 'node:path';
import { access, readdir, readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);

export type NetworkCounters = Map<string, { rxBytes: number; txBytes: number }>;
export type DiskCounters = Map<string, { readBytes: number; writeBytes: number }>;

/** Cumulative byte counters keyed by a stable device id; null when that half could not be read at all. */
export type IoCounterSnapshot = {
  network: NetworkCounters | null;
  disks: DiskCounters | null;
};

/** Average host I/O rates in bytes per second between two snapshots; null where no device could be compared. */
export type IoRates = {
  netRxBytesPerSec: number | null;
  netTxBytesPerSec: number | null;
  diskReadBytesPerSec: number | null;
  diskWriteBytesPerSec: number | null;
};

/** Linux /proc/diskstats sector counts are always in 512-byte units, whatever the device's logical block size. */
const DISKSTATS_SECTOR_BYTES = 512;
/** Interface and block device names used to build sysfs paths; anything else is not looked up. */
const SAFE_DEVICE_NAME = /^[\w.:@!+-]+$/;
/** Whole-disk names for when sysfs cannot tell physical disks apart; partitions, loop, dm and md are left out. */
const WHOLE_DISK_NAME = /^(?:[shv]d[a-z]+|xvd[a-z]+|nvme\d+n\d+|mmcblk\d+)$/;

export function isIoMetricsSupported(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32' || platform === 'linux';
}

function isCounter(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/** Parses /proc/net/dev into cumulative received and transmitted bytes per interface. */
export function parseProcNetDev(content: string): NetworkCounters {
  const counters: NetworkCounters = new Map();
  for (const line of content.split('\n')) {
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const name = line.slice(0, colon).trim();
    const fields = line.slice(colon + 1).trim().split(/\s+/);
    const rxBytes = Number(fields[0]);
    const txBytes = Number(fields[8]);
    if (!name || !isCounter(rxBytes) || !isCounter(txBytes)) continue;
    counters.set(name, { rxBytes, txBytes });
  }
  return counters;
}

/** Parses /proc/diskstats into cumulative read and written bytes per block device. */
export function parseProcDiskstats(content: string): DiskCounters {
  const counters: DiskCounters = new Map();
  for (const line of content.split('\n')) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 10) continue;
    const name = fields[2]!;
    const readSectors = Number(fields[5]);
    const writtenSectors = Number(fields[9]);
    if (!isCounter(readSectors) || !isCounter(writtenSectors)) continue;
    counters.set(name, { readBytes: readSectors * DISKSTATS_SECTOR_BYTES, writeBytes: writtenSectors * DISKSTATS_SECTOR_BYTES });
  }
  return counters;
}

function pick<T>(all: Map<string, T>, keep: (name: string) => boolean): Map<string, T> {
  return new Map([...all].filter(([name]) => keep(name)));
}

/**
 * Keeps interfaces backed by a device (sysfs has a `device` link), so traffic that also crosses a bridge,
 * veth pair or tunnel is not counted twice. Inside a container the only interface is usually a veth with
 * no device; then everything except loopback is counted.
 */
export function selectLinuxInterfaces(all: NetworkCounters, physical: ReadonlySet<string>): NetworkCounters {
  const backed = pick(all, (name) => physical.has(name));
  return backed.size > 0 ? backed : pick(all, (name) => name !== 'lo');
}

/**
 * Keeps whole physical disks so partitions, device-mapper, RAID and loop devices stacked on them are not counted
 * again. `physical` is the set of /sys/block entries with a `device` link, or null when sysfs could not be read.
 */
export function selectLinuxDisks(all: DiskCounters, physical: ReadonlySet<string> | null): DiskCounters {
  if (physical) {
    // sysfs spells a slash in a device name (cciss/c0d0) as "!".
    const backed = pick(all, (name) => physical.has(name.replaceAll('/', '!')));
    if (backed.size > 0) return backed;
  }
  return pick(all, (name) => WHOLE_DISK_NAME.test(name));
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function readLinuxNetwork(): Promise<NetworkCounters> {
  const all = parseProcNetDev(await readFile('/proc/net/dev', 'utf8'));
  const physical = new Set<string>();
  await Promise.all([...all.keys()].map(async (name) => {
    if (SAFE_DEVICE_NAME.test(name) && await exists(path.posix.join('/sys/class/net', name, 'device'))) physical.add(name);
  }));
  return selectLinuxInterfaces(all, physical);
}

async function readLinuxDisks(): Promise<DiskCounters> {
  const all = parseProcDiskstats(await readFile('/proc/diskstats', 'utf8'));
  let physical: Set<string> | null = null;
  try {
    const entries = await readdir('/sys/block');
    const found = new Set<string>();
    await Promise.all(entries.map(async (name) => {
      if (SAFE_DEVICE_NAME.test(name) && await exists(path.posix.join('/sys/block', name, 'device'))) found.add(name);
    }));
    physical = found;
  } catch {
    physical = null;
  }
  return selectLinuxDisks(all, physical);
}

type WindowsAdapter = { id: string; hardware: boolean; virtual: boolean; rx: number; tx: number };

/**
 * Keeps hardware adapters, so a VPN, proxy TUN or Hyper-V virtual switch that carries the same traffic again is
 * not added on top. Falls back to non-virtual adapters, then to all, for VMs whose synthetic NIC is not flagged as hardware.
 */
export function selectWindowsAdapters<T extends Pick<WindowsAdapter, 'hardware' | 'virtual'>>(adapters: T[]): T[] {
  const hardware = adapters.filter((adapter) => adapter.hardware);
  if (hardware.length > 0) return hardware;
  const physical = adapters.filter((adapter) => !adapter.virtual);
  return physical.length > 0 ? physical : adapters;
}

function asList(value: unknown): unknown[] | null {
  if (value === null || value === undefined) return null;
  return Array.isArray(value) ? value : [value];
}

/** Parses the JSON printed by the Windows counter script; a half that failed in PowerShell comes back as null. */
export function parseWindowsIoCounters(stdout: string): IoCounterSnapshot {
  const parsed = JSON.parse(stdout) as { disks?: unknown; nets?: unknown };
  const diskList = asList(parsed.disks);
  const netList = asList(parsed.nets);

  let disks: DiskCounters | null = null;
  if (diskList) {
    disks = new Map();
    for (const item of diskList as Array<Record<string, unknown>>) {
      if (typeof item?.id !== 'string' || !isCounter(item.read) || !isCounter(item.write)) continue;
      disks.set(item.id, { readBytes: item.read, writeBytes: item.write });
    }
  }

  let network: NetworkCounters | null = null;
  if (netList) {
    const adapters = (netList as Array<Record<string, unknown>>).flatMap((item): WindowsAdapter[] =>
      typeof item?.id === 'string' && isCounter(item.rx) && isCounter(item.tx)
        ? [{ id: item.id, hardware: item.hardware === true, virtual: item.virtual === true, rx: item.rx, tx: item.tx }]
        : []);
    network = new Map(selectWindowsAdapters(adapters).map((adapter) => [adapter.id, { rxBytes: adapter.rx, txBytes: adapter.tx }]));
  }

  return { network, disks };
}

// Performance counter paths are localized (Get-Counter and typeperf fail with English paths on a Chinese
// Windows), so the raw WMI/CIM classes are read instead; their names and properties are never translated.
// Adapters are keyed by DeviceID because users can rename the alias. Same module loading and quoting rules
// as readProcesses in metrics-service.ts: no autoload, no double quotes.
const WINDOWS_IO_SCRIPT = [
  `$PSModuleAutoLoadingPreference = 'None'; Import-Module ($PSHOME + '\\Modules\\CimCmdlets'), ($PSHOME + '\\Modules\\Microsoft.PowerShell.Utility');`,
  `$disks = $null; try { $disks = @(Get-CimInstance -ClassName Win32_PerfRawData_PerfDisk_PhysicalDisk -Property Name,DiskReadBytesPersec,DiskWriteBytesPersec -ErrorAction Stop | Where-Object { $_.Name -ne '_Total' } | ForEach-Object { [PSCustomObject]@{ id=[string]$_.Name; read=[double]$_.DiskReadBytesPersec; write=[double]$_.DiskWriteBytesPersec } }) } catch {};`,
  `$nets = $null; try { $stats = @{}; Get-CimInstance -Namespace root/StandardCimv2 -ClassName MSFT_NetAdapterStatisticsSettingData -Property Name,ReceivedBytes,SentBytes -ErrorAction Stop | ForEach-Object { $stats[[string]$_.Name] = $_ }; $nets = @(Get-CimInstance -Namespace root/StandardCimv2 -ClassName MSFT_NetAdapter -Property Name,DeviceID,HardwareInterface,Virtual -ErrorAction Stop | Where-Object { $stats.ContainsKey([string]$_.Name) } | ForEach-Object { $s = $stats[[string]$_.Name]; [PSCustomObject]@{ id=[string]$_.DeviceID; hardware=[bool]$_.HardwareInterface; virtual=[bool]$_.Virtual; rx=[double]$s.ReceivedBytes; tx=[double]$s.SentBytes } }) } catch {};`,
  `[PSCustomObject]@{ disks=$disks; nets=$nets } | ConvertTo-Json -Compress -Depth 4`,
].join(' ');

/**
 * Only the 5-minute background sampler calls this, so it can wait for the first, cold WMI query
 * (about 1–2.5 s on a desktop, longer on a loaded server).
 */
export async function readWindowsIoCounters(timeoutMs = 15_000): Promise<IoCounterSnapshot> {
  const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const { stdout } = await execute(executable, ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_IO_SCRIPT], {
    windowsHide: true, timeout: timeoutMs, maxBuffer: 1024 * 1024,
    env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR },
  });
  return parseWindowsIoCounters(stdout);
}

/** Reads cumulative host network and disk counters for this platform; unsupported platforms return nulls. */
export async function readIoCounters(): Promise<IoCounterSnapshot> {
  if (process.platform === 'win32') return readWindowsIoCounters();
  if (process.platform === 'linux') {
    const [network, disks] = await Promise.allSettled([readLinuxNetwork(), readLinuxDisks()]);
    return {
      network: network.status === 'fulfilled' ? network.value : null,
      disks: disks.status === 'fulfilled' ? disks.value : null,
    };
  }
  return { network: null, disks: null };
}

/**
 * Sums per-device deltas so a device that appeared, disappeared or reset its counter between the two
 * snapshots is skipped instead of turning the total negative or into a spike.
 */
function deltaRate<T>(
  previous: Map<string, T> | null,
  current: Map<string, T> | null,
  read: (value: T) => number,
  elapsedSec: number,
): number | null {
  if (!previous || !current || !(elapsedSec > 0)) return null;
  let total = 0;
  let compared = 0;
  for (const [id, value] of current) {
    const before = previous.get(id);
    if (before === undefined) continue;
    const delta = read(value) - read(before);
    if (!(delta >= 0)) continue;
    total += delta;
    compared += 1;
  }
  return compared > 0 ? total / elapsedSec : null;
}

export function computeIoRates(previous: IoCounterSnapshot, current: IoCounterSnapshot, elapsedMs: number): IoRates {
  const elapsedSec = elapsedMs / 1000;
  return {
    netRxBytesPerSec: deltaRate(previous.network, current.network, (v) => v.rxBytes, elapsedSec),
    netTxBytesPerSec: deltaRate(previous.network, current.network, (v) => v.txBytes, elapsedSec),
    diskReadBytesPerSec: deltaRate(previous.disks, current.disks, (v) => v.readBytes, elapsedSec),
    diskWriteBytesPerSec: deltaRate(previous.disks, current.disks, (v) => v.writeBytes, elapsedSec),
  };
}

export const EMPTY_IO_RATES: IoRates = {
  netRxBytesPerSec: null,
  netTxBytesPerSec: null,
  diskReadBytesPerSec: null,
  diskWriteBytesPerSec: null,
};

export type IoRateSamplerOptions = {
  read?: () => Promise<IoCounterSnapshot>;
  /** Monotonic clock in milliseconds; injectable so tests do not wait. */
  now?: () => number;
};

export type IoRateSampler = {
  /** Takes a baseline without producing rates, so the first background sample already has values. */
  prime(): Promise<void>;
  /**
   * Reads counters and returns the average rates since the previous read. Returns all-null rates (and starts
   * over from this read) when there is no baseline yet or more than `maxElapsedMs` has passed, e.g. after the
   * computer slept: an average across that gap would hide the gap the trend chart is meant to show.
   */
  sample(maxElapsedMs: number): Promise<IoRates>;
  /** Drops the baseline and invalidates reads in flight. */
  reset(): void;
  /** Per half, whether the latest read failed or kept no device; both false before the first read and after reset. */
  readFailed(): { network: boolean; disk: boolean };
};

export function createIoRateSampler(options: IoRateSamplerOptions = {}): IoRateSampler {
  const read = options.read ?? readIoCounters;
  const now = options.now ?? (() => performance.now());
  let previous: { snapshot: IoCounterSnapshot; at: number } | null = null;
  let generation = 0;
  let failed = { network: false, disk: false };

  async function take(): Promise<{ snapshot: IoCounterSnapshot; at: number } | null> {
    const started = generation;
    let snapshot: IoCounterSnapshot;
    try {
      snapshot = await read();
    } catch {
      snapshot = { network: null, disks: null };
    }
    if (started !== generation) return null;
    // An empty map counts as failed too: filters that drop every device would otherwise store NULL forever unnoticed.
    failed = { network: !snapshot.network?.size, disk: !snapshot.disks?.size };
    return { snapshot, at: now() };
  }

  return {
    async prime() {
      const next = await take();
      if (next) previous = next;
    },
    async sample(maxElapsedMs) {
      const next = await take();
      if (!next) return EMPTY_IO_RATES;
      const before = previous;
      previous = next;
      if (!before) return EMPTY_IO_RATES;
      const elapsedMs = next.at - before.at;
      if (!(elapsedMs > 0) || elapsedMs > maxElapsedMs) return EMPTY_IO_RATES;
      return computeIoRates(before.snapshot, next.snapshot, elapsedMs);
    },
    reset() {
      generation += 1;
      previous = null;
      failed = { network: false, disk: false };
    },
    readFailed() {
      return { ...failed };
    },
  };
}
