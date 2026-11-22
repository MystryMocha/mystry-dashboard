import os from 'node:os';
import path from 'node:path';
import { readFile, statfs } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { renderPanelMessage, type DashboardMetrics, type PanelMessage, type ServerMessageKey } from '@mystry/shared';

const execute = promisify(execFile);
type Target = { id: string; pid: number };
type RawProcess = { pid: number; identity: string; cpuMs: number; memoryBytes: number };

/** CPU is normalized by the total capacity of all logical cores, so a multi-core process does not exceed 100%. */
export function cpuUsage(deltaCpuMs: number, deltaWallMs: number, cores: number): number | null {
  if (deltaCpuMs < 0 || deltaWallMs <= 0 || cores <= 0) return null;
  return Math.min(100, Math.max(0, deltaCpuMs / deltaWallMs / cores * 100));
}

export async function readProcesses(targets: Target[], powershellTimeoutMs = 3500): Promise<RawProcess[]> {
  if (!targets.length) return [];
  if (process.platform === 'win32') {
    // Only integer PIDs obtained internally are interpolated; all instances are queried in one batch, with time and output limits.
    const ids = targets.map(t => t.pid).filter(Number.isSafeInteger).join(',');
    const script = `Get-Process -Id ${ids} -ErrorAction SilentlyContinue | ForEach-Object { try { [PSCustomObject]@{ pid=$_.Id; identity=$_.StartTime.ToUniversalTime().Ticks.ToString(); cpuMs=$_.TotalProcessorTime.TotalMilliseconds; memoryBytes=$_.WorkingSet64 } } catch {} } | ConvertTo-Json -Compress`;
    const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const { stdout } = await execute(executable, ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true, timeout: powershellTimeoutMs, maxBuffer: 1024 * 1024,
      env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR },
    });
    if (!stdout.trim()) return [];
    const parsed = JSON.parse(stdout);
    return (Array.isArray(parsed) ? parsed : [parsed]).filter((p: RawProcess) =>
      Number.isSafeInteger(p.pid) && typeof p.identity === 'string'
      && Number.isFinite(p.cpuMs) && p.cpuMs >= 0 && Number.isFinite(p.memoryBytes) && p.memoryBytes >= 0);
  }
  if (process.platform === 'linux') {
    const { stdout } = await execute('getconf', ['CLK_TCK'], { timeout: 1000, maxBuffer: 1024 });
    const ticks = Number(stdout.trim());
    if (!(ticks > 0)) throw new Error('Cannot read the system clock tick rate.');
    const results = await Promise.allSettled(targets.map(async ({ pid }) => {
      const [stat, status] = await Promise.all([readFile(`/proc/${pid}/stat`, 'utf8'), readFile(`/proc/${pid}/status`, 'utf8')]);
      const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
      const rss = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status);
      if (!rss) throw new Error('The process has exited or cannot be sampled.');
      return { pid, identity: fields[19]!, cpuMs: (Number(fields[11]) + Number(fields[12])) / ticks * 1000, memoryBytes: Number(rss[1]) * 1024 };
    }));
    return results.flatMap(r => r.status === 'fulfilled' ? [r.value] : []);
  }
  return [];
}

export class MetricsService {
  private cached: DashboardMetrics | null = null;
  private cachedAt = 0;
  private pending: Promise<DashboardMetrics> | null = null;
  private previousCpu: { total: number; idle: number } | null = null;
  private previousProcesses = new Map<string, RawProcess & { at: number }>();
  private highSince = new Map<string, number>();

  constructor(private readonly dataDir: string, private readonly targets: () => Target[]) {}

  get(): Promise<DashboardMetrics> {
    if (this.pending) return this.pending;
    if (this.cached && performance.now() - this.cachedAt < 4000) return Promise.resolve(this.cached);
    this.pending = this.sample().then(value => {
      this.cached = value; this.cachedAt = performance.now(); return value;
    }).finally(() => { this.pending = null; });
    return this.pending;
  }

  private async sample(): Promise<DashboardMetrics> {
    const targets = this.targets();
    const [diskResult, processResult] = await Promise.allSettled([statfs(this.dataDir), readProcesses(targets)]);
    const now = performance.now();
    const cpus = os.cpus();
    const cpu = cpus.reduce((sum, item) => ({ idle: sum.idle + item.times.idle, total: sum.total + Object.values(item.times).reduce((a, b) => a + b, 0) }), { idle: 0, total: 0 });
    const previous = this.previousCpu;
    const delta = previous ? cpu.total - previous.total : 0;
    const cpuPercent = previous && delta > 0 ? Math.max(0, Math.min(100, (1 - (cpu.idle - previous.idle) / delta) * 100)) : null;
    this.previousCpu = cpu;
    const totalBytes = os.totalmem();
    const memory = { totalBytes, usedBytes: Math.max(0, totalBytes - os.freemem()) };
    const disk = diskResult.status === 'fulfilled' ? { availableBytes: diskResult.value.bavail * diskResult.value.bsize, totalBytes: diskResult.value.blocks * diskResult.value.bsize } : null;
    const instances: DashboardMetrics['instances'] = {};
    const next = new Map<string, RawProcess & { at: number }>();
    // Instances that exited or restarted during the query do not reuse the old process sample.
    const current = new Map(this.targets().map(t => [t.id, t.pid]));
    const rows = new Map((processResult.status === 'fulfilled' ? processResult.value : []).map(p => [p.pid, p]));
    for (const target of targets) {
      if (current.get(target.id) !== target.pid) continue;
      const raw = rows.get(target.pid);
      const old = this.previousProcesses.get(target.id);
      const validOld = raw && old && old.pid === raw.pid && old.identity === raw.identity;
      instances[target.id] = raw ? {
        memoryBytes: raw.memoryBytes,
        cpuPercent: validOld ? cpuUsage(raw.cpuMs - old.cpuMs, now - old.at, cpus.length) : null,
        state: validOld ? 'ready' : 'collecting',
      } : { cpuPercent: null, memoryBytes: null, state: 'unavailable' };
      if (raw) next.set(target.id, { ...raw, at: now });
    }
    this.previousProcesses = next;
    // Warnings return both the English text and the message key; Web uses the key to tell the warning kind and shows it in the current language.
    const warningsI18n: PanelMessage[] = [];
    const conditions: Array<[string, boolean, ServerMessageKey]> = [
      ['cpu', cpuPercent !== null && cpuPercent >= 90, 'server.system.metricsCpuHigh'],
      ['memory', totalBytes > 0 && memory.usedBytes / totalBytes >= 0.9, 'server.system.metricsMemoryHigh'],
    ];
    for (const [key, high, messageKey] of conditions) {
      if (!high || (this.cachedAt && now - this.cachedAt > 15000)) this.highSince.delete(key);
      if (high && !this.highSince.has(key)) this.highSince.set(key, now);
      if (high && now - this.highSince.get(key)! >= 30000) warningsI18n.push({ key: messageKey });
    }
    if (disk && (disk.availableBytes < 5 * 1024 ** 3 || disk.availableBytes / disk.totalBytes < 0.1)) warningsI18n.push({ key: 'server.system.metricsDiskLow' });
    const warnings = warningsI18n.map((message) => renderPanelMessage(message));
    return { sampledAt: new Date().toISOString(), cpuPercent, memory, disk, instances, warnings, warningsI18n };
  }
}
