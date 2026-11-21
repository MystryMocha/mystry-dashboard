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

/** Server monitoring warning: shown in the current language when there is a message key, otherwise the server's original text. */
export function metricWarningTexts(metrics: Metrics, tm: I18n['tm']): string[] {
  return metrics.warnings.map((warning, index) => {
    const message = metrics.warningsI18n?.[index];
    return tm(isPanelMessage(message) ? message : undefined, warning);
  });
}

/** Tells by message key whether a certain kind of warning is present. */
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
  // Only the string key is stored and the text is resolved in the current language at render time, so error messages follow a language switch too.
  const [errorKey, setErrorKey] = useState<MessageKey | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const mounted = useRef(false);
  // Only a manual refresh by the user enters busy: if routine polling also toggled the button's disabled state and text, keyboard/screen reader users focused on the button would be interrupted every 5 seconds.
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

/** Thin usage bar: values 0–100, drawn full when above; with null only the track shows. Purely decorative, with the number given by the text beside it. */
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

/** Local resources: three thin usage bars for CPU, memory and the data disk, with the matching one turning red on a warning. */
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
