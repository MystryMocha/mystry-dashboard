import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { BookOpen, FolderDown, Globe, Network, Plus, Wifi } from 'lucide-react';
import type { InstanceInfo } from '@mystry/shared';
import { api } from '../api';
import { DirectSection } from '../components/DirectSection';
import { LanSection } from '../components/LanSection';
import { useGuideOpen } from '../components/MultiplayerLayout';
import { MultiplayerTab } from '../components/MultiplayerTab';
import { PageHeader } from '../components/PageHeader';
import { WhitelistNotice } from '../components/WhitelistNotice';
import { errorMessage } from '../errors';
import { usePolling } from '../hooks/usePolling';
import { useI18n } from '../i18n';

const METHODS = ['direct', 'lan', 'frp'] as const;
type MultiplayerMethod = (typeof METHODS)[number];

/** An unspecified or unrecognized mode falls to "same network": it needs no install or configuration and is the one most likely to succeed. */
function multiplayerMethod(value: string | null): MultiplayerMethod {
  return METHODS.find((method) => method === value) ?? 'direct';
}
/**
 * Multiplayer is a panel-level entry. Instance selection and the mode switcher share one row, and below them only one mode is shown at a time;
 * each mode decides the content of the guide column on the right itself, and the open/closed state is saved here in one place.
 */
export function MultiplayerPage() {
  const { t } = useI18n();
  const [params, setParams] = useSearchParams();
  const [instances, setInstances] = useState<InstanceInfo[] | null>(null);
  const [error, setError] = useState('');
  const [guideOpen, setGuideOpen] = useGuideOpen();
  const guideToggleRef = useRef<HTMLButtonElement>(null);
  const guideCloseRef = useRef<HTMLButtonElement>(null);
  // After the guide is closed or opened the clicked button disappears; focus is handed to the button that takes its place, so keyboard users do not fall back to the start of the page.
  const guideFocus = useRef(false);
  useEffect(() => {
    if (!guideFocus.current) return;
    guideFocus.current = false;
    (guideOpen ? guideCloseRef : guideToggleRef).current?.focus();
  }, [guideOpen]);
  function changeGuide(next: boolean) {
    guideFocus.current = true;
    setGuideOpen(next);
  }
  const guide = { open: guideOpen, onClose: () => changeGuide(false), closeRef: guideCloseRef };

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
      <PageHeader title={t('nav.multiplayer')} />
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
          <div className="multiplayer-toolbar">
            <div className="field multiplayer-instance">
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
                className={`segmented-item${method === 'direct' ? ' active' : ''}`}
                aria-pressed={method === 'direct'}
                onClick={() => chooseMethod('direct')}
              >
                <Wifi size={15} aria-hidden="true" />
                {t('multiplayer.method.direct')}
              </button>
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
            {!guideOpen && (
              <button ref={guideToggleRef} className="btn btn-sm multiplayer-guide-toggle" type="button" onClick={() => changeGuide(true)}>
                <BookOpen size={15} aria-hidden="true" />
                {t('multiplayer.guide.open')}
              </button>
            )}
          </div>
          {selected && (
            <WhitelistNotice key={selected.id} instanceId={selected.id} status={selected.status} linkConsole />
          )}
          {selected && method === 'direct' && (
            <DirectSection
              key={selected.id}
              instance={selected}
              guide={guide}
              onChooseVirtualLan={() => chooseMethod('lan')}
              onInstanceChanged={load}
            />
          )}
          {selected && method === 'lan' && (
            <LanSection key={selected.id} instanceId={selected.id} guide={guide} />
          )}
          {selected && method === 'frp' && (
            <MultiplayerTab key={selected.id} instanceId={selected.id} guide={guide} />
          )}
        </>
      )}
    </div>
  );
}
