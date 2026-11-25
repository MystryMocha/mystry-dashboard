import type { InstanceInfo } from '@mystry/shared';
import { useI18n } from '../i18n';
import { instanceStatusKey } from '../instance-status';

export type StatusTone = 'running' | 'stopped' | 'starting' | 'stopping' | 'crashed' | 'warning';

/** Status pill: a dot + text, with colors by meaning (running green, transitional amber, abnormal red, stopped grey). */
export function StatusPill({
  tone,
  icon,
  children,
}: {
  tone: StatusTone;
  icon?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <span className={`status-pill ${tone}`}>
      {icon ?? <span className="status-dot" aria-hidden="true" />}
      {children}
    </span>
  );
}

export function InstanceStatusPill({ instance }: { instance: InstanceInfo }) {
  const { t } = useI18n();
  if (instance.requiresMigration) return <StatusPill tone="warning">{t('instance.status.migration')}</StatusPill>;
  const key = instanceStatusKey(instance.status);
  return <StatusPill tone={instance.status}>{key ? t(key) : instance.status}</StatusPill>;
}
