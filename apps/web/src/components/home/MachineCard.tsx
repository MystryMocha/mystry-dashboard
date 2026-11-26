import { ChevronRight, MonitorSmartphone } from 'lucide-react';
import type { StatsOverview } from '@mystry/shared';
import { useI18n } from '../../i18n';
import { formatCapacity, formatUptime } from './format';

interface MachineCardProps {
  overview: StatsOverview | null;
  loading: boolean;
  error: string;
  onRetry: () => void;
  onOpenRemoteAccess: () => void;
}

/**
 * Row 2 right panel: host specifications and uptime.
 * Keeps the "Open on Another Device" entry rendered below 768px even if the history API fails, because the top bar hides that button on phones.
 */
export function MachineCard({
  overview,
  loading,
  error,
  onRetry,
  onOpenRemoteAccess,
}: MachineCardProps) {
  const i18n = useI18n();
  const { t, fmt } = i18n;
  const host = overview?.host ?? null;
  const referenceMs = overview ? Date.parse(overview.to) : Date.now();
  const uptimeText = host ? formatUptime(host.bootedAt, Number.isFinite(referenceMs) ? referenceMs : Date.now(), i18n) : '—';

  return (
    <section className="form-section" aria-labelledby="home-machine-title">
      <div className="home-section-head">
        <h2 className="form-section-title" id="home-machine-title">{t('home.machine.title')}</h2>
      </div>

      <div className="home-panel home-machine-panel">
        {loading && !host ? (
          <div className="home-panel-state" role="status">
            <span className="spinner spinner-sm" aria-hidden="true" />
            <span>{t('common.loading')}</span>
          </div>
        ) : error && !host ? (
          <div className="home-panel-state is-error" role="alert">
            <span>{t('home.history.error')}</span>
            <button type="button" className="link-button" onClick={onRetry}>{t('action.retry')}</button>
          </div>
        ) : host ? (
          <dl className="home-facts">
            <div>
              <dt>{t('home.machine.os')}</dt>
              <dd title={host.osName}>{host.osName}</dd>
            </div>
            {host.cpuModel && (
              <div>
                <dt>{t('home.machine.cpu')}</dt>
                <dd title={host.cpuModel}>{host.cpuModel}</dd>
              </div>
            )}
            <div>
              <dt>{t('home.machine.threads')}</dt>
              <dd>{fmt.number(host.cpuThreads)}</dd>
            </div>
            <div>
              <dt>{t('home.machine.memory')}</dt>
              <dd>{formatCapacity(host.totalMemoryBytes, fmt)}</dd>
            </div>
            <div>
              <dt>{t('home.machine.uptime')}</dt>
              <dd title={uptimeText}>{uptimeText}</dd>
            </div>
          </dl>
        ) : null}

        <button type="button" className="home-machine-remote" onClick={onOpenRemoteAccess}>
          <MonitorSmartphone size={16} aria-hidden="true" className="home-machine-remote-icon" />
          <span className="home-machine-remote-label">{t('remoteAccess.entry')}</span>
          <ChevronRight size={16} aria-hidden="true" className="home-chevron" />
        </button>
      </div>
    </section>
  );
}
