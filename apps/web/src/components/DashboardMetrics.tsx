import { useCallback, useEffect, useRef, useState } from 'react';
import { Cpu, HardDrive, MemoryStick, type LucideIcon } from 'lucide-react';
import {
  isPanelMessage,
  type DashboardMetrics as Metrics,
  type InstanceInfo,
  type ServerMessageKey,
} from '@mystry/shared';
import { api } from '../api';
import { usePolling } from '../hooks/usePolling';
import { useI18n, type I18n, type MessageKey } from '../i18n';

/** 服务端监测告警：有消息键时按当前语言显示，否则显示服务端原文。 */
export function metricWarningTexts(metrics: Metrics, tm: I18n['tm']): string[] {
  return metrics.warnings.map((warning, index) => {
    const message = metrics.warningsI18n?.[index];
    return tm(isPanelMessage(message) ? message : undefined, warning);
  });
}

/** 按消息键判断是否出现某类告警。 */
function hasWarning(metrics: Metrics | null, key: ServerMessageKey): boolean {
  return metrics?.warningsI18n?.some((message) => message.key === key) ?? false;
}

export function processMetric(
  inst: InstanceInfo,
  metrics: Metrics | null,
  error: string,
  kind: 'cpu' | 'memory',
  { t, fmt }: Pick<I18n, 't' | 'fmt'>,
): string {
  if (!['running', 'starting', 'stopping'].includes(inst.status)) return '—';
  const sample = metrics?.instances[inst.id];
  const value = kind === 'cpu' ? sample?.cpuPercent : sample?.memoryBytes;
  if (value != null) {
    const text = kind === 'cpu' ? fmt.percent(value) : `${fmt.gib(value)} GiB`;
    return error ? t('dashboard.metrics.valueStale', { value: text }) : text;
  }
  return error || sample?.state === 'unavailable' ? t('dashboard.metrics.unavailable') : t('dashboard.metrics.collecting');
}

export function useDashboardMetrics() {
  const { t } = useI18n();
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  // 只保存文案键，渲染时按当前语言取文案，切换语言后错误提示也会跟着变。
  const [errorKey, setErrorKey] = useState<MessageKey | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const mounted = useRef(false);
  const refresh = useCallback(async () => {
    if (pending.current) return;
    pending.current = true; setBusy(true);
    try {
      const result = await api<Metrics>('/api/system/metrics');
      if (!result.memory || !result.instances || !Array.isArray(result.warnings)) throw new Error('监测数据暂不可用');
      if (mounted.current) { setMetrics(result); setErrorKey(null); }
    } catch {
      if (mounted.current) setErrorKey('dashboard.metrics.fetchFailed');
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
  const error = errorKey ? t(errorKey) : '';
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
  const { t, fmt } = useI18n();
  const unavailable = t('dashboard.metrics.unavailable');
  const collecting = t('dashboard.metrics.collecting');
  return <>
    <MetricWidget
      label={t('dashboard.metric.hostCpu.label')}
      icon={Cpu}
      tone="blue"
      value={metrics?.cpuPercent == null ? (error ? unavailable : collecting) : fmt.percent(metrics.cpuPercent)}
      detail={t('dashboard.metric.hostCpu.detail')}
      ratio={metrics?.cpuPercent}
      warning={hasWarning(metrics, 'server.system.metricsCpuHigh')}
    />
    <MetricWidget
      label={t('dashboard.metric.hostMemory.label')}
      icon={MemoryStick}
      tone="purple"
      value={metrics ? `${fmt.gib(metrics.memory.usedBytes)} / ${fmt.gib(metrics.memory.totalBytes)}` : (error ? unavailable : collecting)}
      detail={t('dashboard.metric.hostMemory.detail')}
      ratio={metrics ? metrics.memory.usedBytes / metrics.memory.totalBytes * 100 : null}
      warning={hasWarning(metrics, 'server.system.metricsMemoryHigh')}
    />
    <MetricWidget
      label={t('dashboard.metric.disk.label')}
      icon={HardDrive}
      tone="orange"
      value={metrics?.disk ? `${fmt.gib(metrics.disk.availableBytes)} GiB` : (metrics || error ? unavailable : collecting)}
      detail={t('dashboard.metric.disk.detail')}
      ratio={metrics?.disk ? (1 - metrics.disk.availableBytes / metrics.disk.totalBytes) * 100 : null}
      warning={hasWarning(metrics, 'server.system.metricsDiskLow')}
    />
  </>;
}
