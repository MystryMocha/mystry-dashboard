import { useCallback, useState } from 'react';
import { Link, NavLink, Route, Routes, useParams } from 'react-router-dom';
import {
  ChevronLeft,
  Folder,
  Play,
  Power,
  RotateCcw,
  Settings,
  Sliders,
  Terminal,
  TriangleAlert,
} from 'lucide-react';
import type { InstanceInfo } from '@mystry/shared';
import { api, controlInstance, instanceApi, type InstanceAction } from '../api';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { ConfigTab } from '../components/ConfigTab';
import { ConsolePanel } from '../components/ConsolePanel';
import { CoreIcon } from '../components/CoreIcon';
import { EulaCheckbox } from '../components/EulaCheckbox';
import { FilesTab } from '../components/FilesTab';
import { JavaRuntimeSelect } from '../components/JavaRuntimeSelect';
import { JvmSettingsEditor } from '../components/JvmSettingsEditor';
import { InstanceStatusPill } from '../components/StatusPill';
import { UnsavedChangesDialog } from '../components/UnsavedChangesDialog';
import { errorMessage } from '../errors';
import { useInstanceAction } from '../hooks/useInstanceAction';
import { usePolling } from '../hooks/usePolling';
import { useUnsavedGuard } from '../hooks/useUnsavedGuard';
import { useI18n } from '../i18n';
import {
  canStartInstance,
  canStopInstance,
  isLifecycleBusy,
  isProcessAlive,
} from '../instance-status';

function ConsoleTab({ instance }: { instance: InstanceInfo }) {
  return <ConsolePanel instanceId={instance.id} canSend={instance.status === 'running'} />;
}

function MigrationPanel({ instance, onAdopt }: { instance: InstanceInfo; onAdopt: () => Promise<void> }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function adopt() {
    setBusy(true); setError('');
    try { await api(instanceApi(instance.id, '/adopt-managed-directory'), { method: 'POST' }); await onAdopt(); }
    catch (err) { setError(errorMessage(err)); }
    finally { setBusy(false); }
  }
  return (
    <div className="card migration-panel">
      <span className="empty-icon is-warning" aria-hidden="true"><TriangleAlert size={26} /></span>
      <h2>{t('instance.migration.title')}</h2>
      <p>{t('instance.migration.instructions')}</p>
      <code className="code-block">{t('instance.path.managed', { id: instance.id })}</code>
      <p className="muted">{t('instance.migration.note')}</p>
      {error && <p className="callout callout-danger" role="alert">{error}</p>}
      <button className="btn btn-primary" type="button" disabled={busy} onClick={() => void adopt()}>
        {busy ? t('instance.migration.checking') : t('instance.migration.adopt')}
      </button>
    </div>
  );
}

type SettingsDraft = Pick<InstanceInfo, 'name' | 'jarFile' | 'jvmArgs' | 'acceptEula' | 'javaRuntimeId'>;

function settingsFromInstance(instance: InstanceInfo): SettingsDraft {
  return {
    name: instance.name,
    jarFile: instance.jarFile,
    jvmArgs: instance.jvmArgs,
    acceptEula: instance.acceptEula,
    javaRuntimeId: instance.javaRuntimeId,
  };
}

function isSameSettings(left: SettingsDraft, right: SettingsDraft): boolean {
  return left.name === right.name
    && left.jarFile === right.jarFile
    && left.jvmArgs === right.jvmArgs
    && left.acceptEula === right.acceptEula
    && left.javaRuntimeId === right.javaRuntimeId;
}

function SettingsTab({
  instance,
  onSaved,
}: {
  instance: InstanceInfo;
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const [name, setName] = useState(instance.name);
  const [jarFile, setJarFile] = useState(instance.jarFile);
  const [jvmArgs, setJvmArgs] = useState(instance.jvmArgs);
  const [acceptEula, setAcceptEula] = useState(instance.acceptEula);
  const [javaRuntimeId, setJavaRuntimeId] = useState<string | null>(instance.javaRuntimeId);
  const [javaMajor, setJavaMajor] = useState<number | null>(null);
  const [jvmValid, setJvmValid] = useState(true);
  const [originalSettings, setOriginalSettings] = useState<SettingsDraft>(() => settingsFromInstance(instance));
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const draft: SettingsDraft = { name, jarFile, jvmArgs, acceptEula, javaRuntimeId };
  const dirty = !isSameSettings(draft, originalSettings);
  const blocker = useUnsavedGuard(dirty, saving);

  async function save() {
    if (!dirty || saving || !jvmValid) return;
    setSaving(true);
    setSaved(false);
    try {
      await api(instanceApi(instance.id), {
        method: 'PATCH',
        json: draft,
      });
      setError('');
      setOriginalSettings(draft);
      setSaved(true);
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="form-stack settings-workspace">
      <section className="form-section">
        <h3 className="form-section-title">{t('instance.settings.section.basic')}</h3>
        <div className="card form-card">
          <div className="field">
            <label htmlFor="instance-settings-name">{t('instance.settings.name.label')}</label>
            <input
              id="instance-settings-name"
              value={name}
              disabled={saving}
              onChange={(e) => {
                setName(e.target.value);
                setSaved(false);
              }}
            />
          </div>
          <div className="field">
            <label htmlFor="instance-settings-jar-file">{t('instance.settings.jarFile.label')}</label>
            <input
              id="instance-settings-jar-file"
              value={jarFile}
              disabled={saving}
              onChange={(e) => {
                setJarFile(e.target.value);
                setSaved(false);
              }}
            />
          </div>
          <div className="field">
            <label htmlFor="instance-settings-install-path">{t('instance.settings.installPath.label')}</label>
            <input
              id="instance-settings-install-path"
              value={instance.installPath ?? t('instance.path.managed', { id: instance.id })}
              readOnly
            />
            <p className="field-help">{t('instance.settings.installPath.help')}</p>
          </div>
        </div>
      </section>

      <section className="form-section">
        <h3 className="form-section-title">{t('instance.settings.section.runtime')}</h3>
        <div className="card form-card">
          <JavaRuntimeSelect
            value={javaRuntimeId}
            onChange={(nextRuntimeId) => {
              setJavaRuntimeId(nextRuntimeId);
              setSaved(false);
            }}
            mcVersion={instance.mcVersion}
            disabled={saving}
            onResolvedMajorChange={setJavaMajor}
          />
          <JvmSettingsEditor
            value={jvmArgs}
            onChange={(next) => {
              setJvmArgs(next);
              setSaved(false);
            }}
            coreType={instance.coreType}
            javaMajor={javaMajor}
            disabled={saving}
            onValidityChange={setJvmValid}
          />
        </div>
      </section>

      <section className="form-section">
        <h3 className="form-section-title">{t('instance.settings.section.eula')}</h3>
        <div className="card form-card">
          <EulaCheckbox
            checked={acceptEula}
            disabled={saving}
            onChange={(checked) => {
              setAcceptEula(checked);
              setSaved(false);
            }}
          />
        </div>
      </section>

      {error && <p className="callout callout-danger" role="alert">{error}</p>}

      <div className="action-bar">
        <span className="action-bar-status" role="status" aria-live="polite">
          {dirty
            ? t('instance.settings.status.dirty')
            : saved ? t('instance.settings.status.saved') : t('instance.settings.status.idle')}
        </span>
        <button className="btn btn-primary" type="button" disabled={!dirty || saving || !jvmValid} onClick={() => void save()}>
          {saving ? t('action.saving') : t('instance.settings.save')}
        </button>
      </div>

      <UnsavedChangesDialog
        blocker={blocker}
        saving={saving}
        title={t('instance.settings.unsaved.title')}
        savingTitle={t('instance.settings.unsaved.savingTitle')}
        description={t('instance.settings.unsaved.description')}
      />
    </div>
  );
}

const hubTabClass = ({ isActive }: { isActive: boolean }) => `segmented-item${isActive ? ' active' : ''}`;

export function InstancePage() {
  const { t } = useI18n();
  const { id = '' } = useParams();
  const [instance, setInstance] = useState<InstanceInfo | null>(null);
  const [loadError, setLoadError] = useState('');
  const [confirmRestart, setConfirmRestart] = useState(false);
  const [confirmForceStop, setConfirmForceStop] = useState(false);

  const load = useCallback(async () => {
    try {
      setInstance(await api<InstanceInfo>(instanceApi(id)));
      setLoadError('');
    } catch (err) {
      setLoadError(errorMessage(err));
    }
  }, [id]);
  usePolling(load);

  const { busyId, error: actionError, run } = useInstanceAction(load);
  const busy = busyId !== null;
  const error = actionError || loadError;

  function act(action: InstanceAction, options?: { force?: boolean }) {
    void run(id, () => controlInstance(id, action, options));
  }

  if (!instance) {
    return (
      <div className="page">
        <Link to="/" className="back-link">
          <ChevronLeft size={18} aria-hidden="true" />
          {t('nav.overview')}
        </Link>
        {error ? (
          <div className="empty-state card" role="alert">
            <p>{error}</p>
            <button className="btn" type="button" onClick={() => void load()}>{t('action.reload')}</button>
          </div>
        ) : (
          <div className="page-loading" role="status">
            <span className="spinner" aria-hidden="true" />
            {t('common.loading')}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="page instance-page">
      <header className="instance-header">
        <Link to="/" className="back-link" title={t('instance.header.backTitle')}>
          <ChevronLeft size={18} aria-hidden="true" />
          {t('nav.overview')}
        </Link>
        <div className="instance-title-row">
          <CoreIcon coreType={instance.coreType} size="lg" />
          <div className="instance-title-text">
            <h1 className="large-title instance-name">{instance.name}</h1>
            <div className="instance-meta">
              <InstanceStatusPill instance={instance} />
              <span>
                {instance.coreType.toUpperCase()}
                {instance.mcVersion ? ` · ${t('instance.header.version', { version: instance.mcVersion })}` : ''}
              </span>
            </div>
          </div>

          <div className="instance-actions">
            {canStartInstance(instance.status) && (
              <button
                className="btn btn-ok"
                type="button"
                disabled={busy || instance.requiresMigration}
                onClick={() => act('start')}
              >
                <Play size={14} aria-hidden="true" />
                {t('action.start')}
              </button>
            )}
            {canStopInstance(instance.status) && (
              <button
                className="btn btn-danger"
                type="button"
                disabled={busy || instance.requiresMigration}
                onClick={() => act('stop')}
              >
                <Power size={14} aria-hidden="true" />
                {t('action.stop')}
              </button>
            )}
            <button
              className="btn"
              type="button"
              disabled={busy || instance.requiresMigration || isLifecycleBusy(instance.status)}
              onClick={() => setConfirmRestart(true)}
            >
              <RotateCcw size={14} aria-hidden="true" />
              {t('action.restart')}
            </button>
            <button
              className="btn btn-plain is-danger"
              type="button"
              disabled={busy || instance.requiresMigration || !isProcessAlive(instance.status)}
              onClick={() => setConfirmForceStop(true)}
            >
              {t('action.forceStop')}
            </button>
          </div>
        </div>
      </header>

      {error && <p className="callout callout-danger" role="alert">{error}</p>}

      {!instance.requiresMigration && (
        <nav className="segmented hub-tabs" aria-label={t('instance.tabs.label')}>
          <NavLink to={`/instances/${id}`} end className={hubTabClass}>
            <Terminal size={15} aria-hidden="true" />
            <span>{t('instance.tab.console')}</span>
          </NavLink>
          <NavLink to={`/instances/${id}/files`} className={hubTabClass}>
            <Folder size={15} aria-hidden="true" />
            <span>{t('instance.tab.files')}</span>
          </NavLink>
          <NavLink to={`/instances/${id}/config`} className={hubTabClass}>
            <Sliders size={15} aria-hidden="true" />
            <span>{t('instance.tab.properties')}</span>
          </NavLink>
          <NavLink to={`/instances/${id}/settings`} className={hubTabClass}>
            <Settings size={15} aria-hidden="true" />
            <span>{t('instance.tab.settings')}</span>
          </NavLink>
        </nav>
      )}

      <div className="instance-body" key={instance.id}>
        {instance.requiresMigration ? (
          <MigrationPanel instance={instance} onAdopt={load} />
        ) : (
          <Routes>
            <Route index element={<ConsoleTab instance={instance} />} />
            <Route path="files" element={<FilesTab instanceId={instance.id} />} />
            <Route path="config" element={<ConfigTab instanceId={instance.id} />} />
            <Route path="settings" element={<SettingsTab instance={instance} onSaved={load} />} />
          </Routes>
        )}
      </div>

      <ConfirmDialog
        open={confirmRestart}
        title={t('instance.restart.title', { name: instance.name })}
        description={t('instance.restart.description')}
        confirmLabel={t('instance.restart.confirm')}
        busy={busy}
        onConfirm={() => {
          setConfirmRestart(false);
          act('restart');
        }}
        onCancel={() => setConfirmRestart(false)}
      />
      <ConfirmDialog
        open={confirmForceStop}
        title={t('instance.forceStop.title', { name: instance.name })}
        description={t('instance.forceStop.description')}
        confirmLabel={t('instance.forceStop.confirm')}
        danger
        busy={busy}
        onConfirm={() => {
          setConfirmForceStop(false);
          act('stop', { force: true });
        }}
        onCancel={() => setConfirmForceStop(false)}
      />
    </div>
  );
}
