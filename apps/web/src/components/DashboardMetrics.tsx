import { useCallback, useEffect, useRef, useState } from 'react';
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
  // 只有用户手动刷新才进入 busy：例行轮询若也切换按钮禁用和文案，聚焦在按钮上的键盘/读屏用户每 5 秒都会被打断。
  const refresh = useCallback(async (manual = false) => {
    if (pending.current) return;
    pending.current = true;
    if (manual) setBusy(true);
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

/** 细长占用条：取值 0–100，超出按满格画；null 时只显示底槽。纯装饰，数值由旁边的文字给出。 */
export function Meter({
  ratio,
  tone = 'neutral',
}: {
  ratio: number | null | undefined;
  tone?: 'neutral' | 'accent' | 'warning';
}) {
  const value = ratio == null || !Number.isFinite(ratio) ? 0 : Math.max(0, Math.min(100, ratio));
  return (
    <span className={`meter is-${tone}`} aria-hidden="true">
      {value > 0 && <span className="meter-fill" style={{ inlineSize: `${value}%` }} />}
    </span>
  );
}

function HostMeter({
  name,
  hint,
  value,
  ratio,
  warning,
}: {
  name: string;
  hint: string;
  value: string;
  ratio: number | null | undefined;
  warning: boolean;
}) {
  return (
    <div className={`host-meter${warning ? ' is-warning' : ''}`} title={hint}>
      <div className="host-meter-head">
        <span className="host-meter-name">{name}</span>
        <span className="host-meter-value">{value}</span>
      </div>
      <Meter ratio={ratio} tone={warning ? 'warning' : 'neutral'} />
    </div>
  );
}

/** 本机资源：CPU、内存、数据盘三条细占用条，告警时对应一条变红。 */
export function HostMeters({ metrics, error }: { metrics: Metrics | null; error: string }) {
  const { t, fmt } = useI18n();
  const placeholder = error ? t('dashboard.metrics.unavailable') : t('dashboard.metrics.collecting');
  return (
    <div className="host-meters">
      <HostMeter
        name={t('dashboard.host.cpu')}
        hint={t('dashboard.host.cpu.hint')}
        value={metrics?.cpuPercent == null ? placeholder : fmt.percent(metrics.cpuPercent)}
        ratio={metrics?.cpuPercent}
        warning={hasWarning(metrics, 'server.system.metricsCpuHigh')}
      />
      <HostMeter
        name={t('dashboard.host.memory')}
        hint={t('dashboard.host.memory.hint')}
        value={metrics ? `${fmt.gib(metrics.memory.usedBytes)} / ${fmt.gib(metrics.memory.totalBytes)} GiB` : placeholder}
        ratio={metrics ? metrics.memory.usedBytes / metrics.memory.totalBytes * 100 : null}
        warning={hasWarning(metrics, 'server.system.metricsMemoryHigh')}
      />
      <HostMeter
        name={t('dashboard.host.disk')}
        hint={t('dashboard.host.disk.hint')}
        value={
          metrics?.disk
            ? t('dashboard.host.diskFree', { value: `${fmt.gib(metrics.disk.availableBytes)} GiB` })
            : metrics ? t('dashboard.metrics.unavailable') : placeholder
        }
        ratio={metrics?.disk ? (1 - metrics.disk.availableBytes / metrics.disk.totalBytes) * 100 : null}
        warning={hasWarning(metrics, 'server.system.metricsDiskLow')}
      />
    </div>
  );
}
