import { useCallback, useEffect, useRef, useState } from 'react';
import { Cpu, HardDrive, MemoryStick, type LucideIcon } from 'lucide-react';
import type { DashboardMetrics as Metrics, InstanceInfo } from '@mystry/shared';
import { api } from '../api';
import { usePolling } from '../hooks/usePolling';

export function gib(bytes: number): string { return (bytes / 1024 ** 3).toFixed(1); }

export function processMetric(inst: InstanceInfo, metrics: Metrics | null, error: string, kind: 'cpu' | 'memory'): string {
  if (!['running', 'starting', 'stopping'].includes(inst.status)) return '—';
  const sample = metrics?.instances[inst.id];
  const value = kind === 'cpu' ? sample?.cpuPercent : sample?.memoryBytes;
  if (value != null) return `${kind === 'cpu' ? `${value.toFixed(1)}%` : `${gib(value)} GiB`}${error ? '（过期）' : ''}`;
  return error || sample?.state === 'unavailable' ? '暂不可用' : '采集中…';
}

export function useDashboardMetrics() {
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const mounted = useRef(false);
  const refresh = useCallback(async () => {
    if (pending.current) return;
    pending.current = true; setBusy(true);
    try {
      const result = await api<Metrics>('/api/system/metrics');
      if (!result.memory || !result.instances || !Array.isArray(result.warnings)) throw new Error('监测数据暂不可用');
      if (mounted.current) { setMetrics(result); setError(''); }
    } catch {
      if (mounted.current) setError('监测数据获取失败');
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  usePolling(refresh);
  return { metrics, error, busy, refresh };
}

export type WidgetTone = 'green' | 'blue' | 'purple' | 'orange';

const RING_RADIUS = 17;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

/** 圆环进度：取值 0–100，null 时只显示底环。 */
export function RingGauge({ ratio }: { ratio: number | null | undefined }) {
  const value = ratio == null || !Number.isFinite(ratio) ? 0 : Math.max(0, Math.min(100, ratio));
  return (
    <svg className="ring" viewBox="0 0 44 44" aria-hidden="true">
      <circle className="ring-track" cx="22" cy="22" r={RING_RADIUS} />
      {/* 取值为 0 时不画进度弧，避免圆头端点留下一个小点。 */}
      {value > 0 && (
        <circle
          className="ring-fill"
          cx="22"
          cy="22"
          r={RING_RADIUS}
          strokeDasharray={RING_CIRCUMFERENCE}
          strokeDashoffset={RING_CIRCUMFERENCE * (1 - value / 100)}
        />
      )}
    </svg>
  );
}

/** 总览指标小组件：标题行 + 大号数值 + 说明，右侧圆环表示占用比例。 */
export function MetricWidget({
  label,
  icon: Icon,
  tone,
  value,
  unit,
  detail,
  ratio,
  warning = false,
}: {
  label: string;
  icon: LucideIcon;
  tone: WidgetTone;
  value: React.ReactNode;
  unit?: string;
  detail: React.ReactNode;
  ratio: number | null | undefined;
  warning?: boolean;
}) {
  return (
    <div className={`widget tone-${warning ? 'red' : tone}${warning ? ' is-warning' : ''}`}>
      <div className="widget-head">
        <span className="widget-icon" aria-hidden="true"><Icon size={14} strokeWidth={2.4} /></span>
        <span className="widget-label">{label}</span>
      </div>
      <div className="widget-body">
        <div className="widget-text">
          <div className="widget-value">
            {value}
            {unit ? <span className="widget-unit">{unit}</span> : null}
          </div>
          <div className="widget-detail">{detail}</div>
        </div>
        <RingGauge ratio={ratio} />
      </div>
    </div>
  );
}

export function HostMetricCards({ metrics, error }: { metrics: Metrics | null; error: string }) {
  return <>
    <MetricWidget
      label="主机 CPU"
      icon={Cpu}
      tone="blue"
      value={metrics?.cpuPercent == null ? (error ? '暂不可用' : '采集中…') : `${metrics.cpuPercent.toFixed(1)}%`}
      detail="整机逻辑核总容量"
      ratio={metrics?.cpuPercent}
      warning={metrics?.warnings.includes('主机 CPU 持续偏高')}
    />
    <MetricWidget
      label="主机内存"
      icon={MemoryStick}
      tone="purple"
      value={metrics ? `${gib(metrics.memory.usedBytes)} / ${gib(metrics.memory.totalBytes)}` : (error ? '暂不可用' : '采集中…')}
      detail="GiB · 已用 / 总量"
      ratio={metrics ? metrics.memory.usedBytes / metrics.memory.totalBytes * 100 : null}
      warning={metrics?.warnings.includes('主机内存持续偏高')}
    />
    <MetricWidget
      label="数据盘空间"
      icon={HardDrive}
      tone="orange"
      value={metrics?.disk ? `${gib(metrics.disk.availableBytes)} GiB` : (metrics || error ? '暂不可用' : '采集中…')}
      detail="剩余空间 · 数据目录所在磁盘"
      ratio={metrics?.disk ? (1 - metrics.disk.availableBytes / metrics.disk.totalBytes) * 100 : null}
      warning={metrics?.warnings.includes('数据盘剩余空间不足')}
    />
  </>;
}
