import { useCallback, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { FolderDown, Globe, Network, Plus } from 'lucide-react';
import type { InstanceInfo } from '@mystry/shared';
import { api } from '../api';
import { LanSection } from '../components/LanSection';
import { MultiplayerTab } from '../components/MultiplayerTab';
import { PageHeader } from '../components/PageHeader';
import { errorMessage } from '../errors';
import { usePolling } from '../hooks/usePolling';
import { useI18n } from '../i18n';

const METHODS = ['lan', 'frp'] as const;
type MultiplayerMethod = (typeof METHODS)[number];

function multiplayerMethod(value: string | null): MultiplayerMethod {
  return value === 'frp' ? 'frp' : 'lan';
}
/** 联机是面板级入口。先选定实例，再用分段切换虚拟局域网或 frp，一次只显示一种。 */
export function MultiplayerPage() {
  const { t } = useI18n();
  const [params, setParams] = useSearchParams();
  const [instances, setInstances] = useState<InstanceInfo[] | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      setInstances(await api<InstanceInfo[]>('/api/instances'));
      setError('');
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);
  usePolling(load);

  const requested = params.get('instance');
  const selected = instances?.find((instance) => instance.id === requested) ?? instances?.[0] ?? null;
  const method = multiplayerMethod(params.get('method'));

  function choose(instanceId: string) {
    const next = new URLSearchParams(params);
    next.set('instance', instanceId);
    setParams(next, { replace: true });
  }

  function chooseMethod(nextMethod: MultiplayerMethod) {
    const next = new URLSearchParams(params);
    if (selected) next.set('instance', selected.id);
    next.set('method', nextMethod);
    setParams(next, { replace: true });
  }

  return (
    <div className="page">
      <PageHeader title={t('nav.multiplayer')} subtitle={t('multiplayer.page.lead')} />
      {error && instances === null ? (
        <div className="empty-state card" role="alert">
          <p>{t('error.instances.load')}</p>
          <button className="btn" type="button" onClick={() => void load()}>{t('action.reload')}</button>
        </div>
      ) : instances === null ? (
        <div className="page-loading" role="status">{t('common.loading')}</div>
      ) : instances.length === 0 ? (
        <div className="empty-state card">
          <h3>{t('empty.instances.title')}</h3>
          <p>{t('empty.instances.body')}</p>
          <div className="empty-actions">
            <Link to="/deploy" className="btn btn-primary">
              <Plus size={16} aria-hidden="true" />
              {t('dashboard.empty.deployFirst')}
            </Link>
            <Link to="/import" className="btn">
              <FolderDown size={16} aria-hidden="true" />
              {t('dashboard.empty.importExisting')}
            </Link>
          </div>
        </div>
      ) : (
        <>
          <div className="field">
            <label htmlFor="multiplayer-instance">{t('multiplayer.page.instance')}</label>
            <select
              id="multiplayer-instance"
              value={selected?.id ?? ''}
              onChange={(event) => choose(event.target.value)}
            >
              {instances.map((instance) => (
                <option key={instance.id} value={instance.id}>{instance.name}</option>
              ))}
            </select>
          </div>
          <div className="segmented multiplayer-mode-switch" role="group" aria-label={t('multiplayer.method.ariaLabel')}>
            <button
              type="button"
              className={`segmented-item${method === 'lan' ? ' active' : ''}`}
              aria-pressed={method === 'lan'}
              onClick={() => chooseMethod('lan')}
            >
              <Network size={15} aria-hidden="true" />
              {t('multiplayer.method.lan')}
            </button>
            <button
              type="button"
              className={`segmented-item${method === 'frp' ? ' active' : ''}`}
              aria-pressed={method === 'frp'}
              onClick={() => chooseMethod('frp')}
            >
              <Globe size={15} aria-hidden="true" />
              {t('multiplayer.method.frp')}
            </button>
          </div>
          {selected && method === 'lan' && (
            <div className="form-stack settings-workspace">
              <LanSection key={selected.id} instanceId={selected.id} />
            </div>
          )}
          {selected && method === 'frp' && (
            <MultiplayerTab key={selected.id} instanceId={selected.id} />
          )}
        </>
      )}
    </div>
  );
}
