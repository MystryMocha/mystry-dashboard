import { useCallback, useRef, useState } from 'react';
import { Link, Navigate, NavLink, Route, Routes, useParams } from 'react-router-dom';
import {
  Archive,
  ChevronLeft,
  Folder,
  Play,
  Power,
  RotateCcw,
  Settings,
  Sliders,
  Terminal,
  Trash2,
  TriangleAlert,
} from 'lucide-react';
import { parseLaunchTarget, type InstanceInfo } from '@mystry/shared';
import { api, controlInstance, instanceApi, type InstanceAction } from '../api';
import { ActionMenu } from '../components/ActionMenu';
import { BackupsTab } from '../components/BackupsTab';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { ConfigTab } from '../components/ConfigTab';
import { ConsolePanel } from '../components/ConsolePanel';
import { CoreIcon, coreDisplayName } from '../components/CoreIcon';
import { DeleteInstanceDialog } from '../components/DeleteInstanceDialog';
import { EulaCheckbox } from '../components/EulaCheckbox';
import { Field, FormFeedbackProvider, focusFirstInvalidField, useFormFeedback } from '../components/Field';
import { FilesTab } from '../components/FilesTab';
import { JavaRuntimeSelect } from '../components/JavaRuntimeSelect';
import { JvmSettingsEditor } from '../components/JvmSettingsEditor';
import { ReadyHint } from '../components/ReadyHint';
import { SaveBar, useFormSubmit, useSavedNotice, type RestartControl } from '../components/SaveBar';
import { StartIssueBanner } from '../components/StartIssueBanner';
import { InstanceStatusPill } from '../components/StatusPill';
import { UnsavedChangesDialog } from '../components/UnsavedChangesDialog';
import { errorMessage } from '../errors';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useToolbarTitle } from '../hooks/useToolbarTitle';
import { useInstanceAction } from '../hooks/useInstanceAction';
import { usePolling } from '../hooks/usePolling';
import { useUnsavedGuard } from '../hooks/useUnsavedGuard';
import { useI18n, type MessageKey } from '../i18n';
import { instanceNameIssue, type Issue } from '../validation';
import {
  canStartInstance,
  canStopInstance,
  isLifecycleBusy,
  isProcessAlive,
} from '../instance-status';

function ConsoleTab({
  instance,
  busy,
  onAgreeEulaAndStart,
}: {
  instance: InstanceInfo;
  busy: boolean;
  onAgreeEulaAndStart: () => void;
}) {
  // The notice is only on the console page: the instance settings page has its own EULA checkbox draft, and changing both at once would overwrite each other.
  const issue = canStartInstance(instance.status) ? instance.startIssue ?? null : null;
  return (
    <>
      {issue && (
        <StartIssueBanner
          issue={issue}
          instanceId={instance.id}
          busy={busy}
          onAgreeEulaAndStart={onAgreeEulaAndStart}
        />
      )}
      {instance.status === 'running' && instance.ready && <ReadyHint instanceId={instance.id} />}
      <ConsolePanel instanceId={instance.id} canSend={instance.status === 'running'} />
    </>
  );
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

const SETTINGS_KEYS = ['name', 'jarFile', 'jvmArgs', 'acceptEula', 'javaRuntimeId'] as const;

/** Settings that differ from when they were loaded; the save bar uses this to write "N unsaved changes". */
function changedSettings(left: SettingsDraft, right: SettingsDraft): (keyof SettingsDraft)[] {
  return SETTINGS_KEYS.filter((key) => left[key] !== right[key]);
}

function SettingsTab({
  instance,
  restart,
  onSaved,
  onDeleted,
}: {
  instance: InstanceInfo;
  /** The instance page's restart entry: while the instance is running, the notice after saving offers "Restart Instance". */
  restart: RestartControl;
  onSaved: () => void;
  /** The instance has been deleted from here: the instance page leaves the current page. */
  onDeleted: () => void;
}) {
  const { t } = useI18n();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const alive = isProcessAlive(instance.status);
  const [name, setName] = useState(instance.name);
  const [jarFile, setJarFile] = useState(instance.jarFile);
  const [jvmArgs, setJvmArgs] = useState(instance.jvmArgs);
  const [acceptEula, setAcceptEula] = useState(instance.acceptEula);
  const [javaRuntimeId, setJavaRuntimeId] = useState<string | null>(instance.javaRuntimeId);
  const [javaMajor, setJavaMajor] = useState<number | null>(null);
  const [jvmValid, setJvmValid] = useState(true);
  // Incremented on discarding changes, so the JVM configurator remounts: unfinished text in its memory box was never sent here, and just setting the value back does not clear it.
  const [jvmEpoch, setJvmEpoch] = useState(0);
  const [originalSettings, setOriginalSettings] = useState<SettingsDraft>(() => settingsFromInstance(instance));
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const feedback = useFormFeedback();
  const savedNotice = useSavedNotice(restart);
  const formRef = useRef<HTMLFormElement>(null);
  const draft: SettingsDraft = { name, jarFile, jvmArgs, acceptEula, javaRuntimeId };
  const changed = changedSettings(draft, originalSettings);
  const dirty = changed.length > 0;
  const blocker = useUnsavedGuard(dirty, saving);
  // What is edited here is an existing name, so clearing it counts as a mistake (the reason is explained after blur), which is not the same as "not filled in yet" in a create form.
  const nameIssue = instanceNameIssue(name);
  // Checked only when the user has changed the jar file name; a value already in the database does not block saving other settings.
  const jarFileIssue: Issue | null = jarFile !== originalSettings.jarFile && jarFile.trim() === '' ? { key: 'validation.jarFile.required' } : null;
  // The save bar names the first field to fix, in the same order as on the page.
  const invalidLabel = nameIssue ? t('validation.fixField', { field: t('instance.settings.name.label') })
    : jarFileIssue ? t('validation.fixField', { field: t('instance.settings.jarFile.label') })
      : jvmValid ? null : t('validation.jvm.invalid');
  const invalid = invalidLabel !== null;
  // The launch target of Forge / NeoForge is the args file the panel recognized, not a jar file name, and is shown read-only.
  const launchTarget = parseLaunchTarget(originalSettings.jarFile);

  async function save() {
    if (!dirty || saving || invalid) return;
    setSaving(true);
    savedNotice.clear();
    try {
      // Only changed items are submitted: an untouched Java that is no longer valid, or a jar that is a launch marker recognized by the panel, must not block saving other settings.
      await api(instanceApi(instance.id), {
        method: 'PATCH',
        json: Object.fromEntries(changed.map((key) => [key, draft[key]])),
      });
      setError('');
      setOriginalSettings(draft);
      feedback.reset();
      // A name change takes effect immediately; the jar, Java, JVM arguments and EULA are read only at start, so a running instance has to restart.
      savedNotice.show(changed.some((key) => key !== 'name'));
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  /** Makes the fields show their error reasons and jumps to the first field to fix; Enter failing to submit and clicking the save bar's status text are the same action. */
  function revealInvalid() {
    feedback.revealAll();
    focusFirstInvalidField(formRef.current);
  }

  function submit() {
    if (!dirty || saving) return;
    if (invalid) revealInvalid();
    else void save();
  }

  const formSubmit = useFormSubmit(submit);

  function discard() {
    setName(originalSettings.name);
    setJarFile(originalSettings.jarFile);
    setJvmArgs(originalSettings.jvmArgs);
    setAcceptEula(originalSettings.acceptEula);
    setJavaRuntimeId(originalSettings.javaRuntimeId);
    setJvmEpoch((epoch) => epoch + 1);
    setJvmValid(true);
    feedback.reset();
    setError('');
  }

  return (
    <>
      <FormFeedbackProvider value={feedback.value}>
        {/* noValidate: validation is done by the page itself, so the browser's native prompts do not block submission. */}
        <form
          ref={formRef}
          className="form-stack settings-workspace"
          noValidate
          {...formSubmit}
        >
          {/* On wide screens basic info and the license agreement are in the left column and the runtime environment in the right; narrow screens stack them in the original order. */}
          <div className="form-columns">
            <div className="form-column">
              <section className="form-section">
                <h3 className="form-section-title">{t('instance.settings.section.basic')}</h3>
                <div className="card form-card">
                  <Field
                    id="instance-settings-name"
                    label={t('instance.settings.name.label')}
                    error={nameIssue ? t(nameIssue.key, nameIssue.params) : null}
                  >
                    {(control) => (
                      <input
                        {...control}
                        value={name}
                        disabled={saving}
                        onChange={(e) => {
                          setName(e.target.value);
                          savedNotice.clear();
                        }}
                      />
                    )}
                  </Field>
                  {launchTarget.kind === 'jar' ? (
                    <Field
                      id="instance-settings-jar-file"
                      label={t('instance.settings.jarFile.label')}
                      error={jarFileIssue ? t(jarFileIssue.key) : null}
                    >
                      {(control) => (
                        <input
                          {...control}
                          value={jarFile}
                          disabled={saving}
                          onChange={(e) => {
                            setJarFile(e.target.value);
                            savedNotice.clear();
                          }}
                        />
                      )}
                    </Field>
                  ) : (
                    <div className="field">
                      <label htmlFor="instance-settings-launch-file">{t('instance.settings.launchFile.label')}</label>
                      <input
                        id="instance-settings-launch-file"
                        // "Not installed" is a state, not a hint for something to fill in, so it is shown as a value in the body text color, not as a low-contrast placeholder.
                        value={launchTarget.kind === 'args' ? launchTarget.path : t('instance.settings.launchFile.pendingValue')}
                        // Paths are often truncated; hover shows the whole thing.
                        title={launchTarget.kind === 'args' ? launchTarget.path : undefined}
                        readOnly
                        aria-describedby="instance-settings-launch-file-help"
                      />
                      <p className="field-help" id="instance-settings-launch-file-help">
                        {t(launchTarget.kind === 'args' ? 'instance.settings.launchFile.argsHelp' : 'instance.settings.launchFile.pendingHelp')}
                      </p>
                    </div>
                  )}
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
                <h3 className="form-section-title">{t('instance.settings.section.eula')}</h3>
                <div className="card form-card">
                  <EulaCheckbox
                    checked={acceptEula}
                    disabled={saving}
                    onChange={(checked) => {
                      setAcceptEula(checked);
                      savedNotice.clear();
                    }}
                  />
                </div>
              </section>
            </div>
            <div className="form-column">
              <section className="form-section">
                <h3 className="form-section-title">{t('instance.settings.section.runtime')}</h3>
                <div className="card form-card">
                  <JavaRuntimeSelect
                    value={javaRuntimeId}
                    onChange={(nextRuntimeId) => {
                      setJavaRuntimeId(nextRuntimeId);
                      savedNotice.clear();
                    }}
                    mcVersion={instance.mcVersion}
                    disabled={saving}
                    onResolvedMajorChange={setJavaMajor}
                  />
                  {/* The JVM configurator shows its own errors; this container takes no part in layout and only lets "jump to the field to fix" land inside it. */}
                  <div className="form-fields" data-field-invalid={jvmValid ? undefined : ''}>
                    <JvmSettingsEditor
                      key={jvmEpoch}
                      value={jvmArgs}
                      onChange={(next) => {
                        setJvmArgs(next);
                        savedNotice.clear();
                      }}
                      coreType={instance.coreType}
                      javaMajor={javaMajor}
                      disabled={saving}
                      onValidityChange={setJvmValid}
                    />
                  </div>
                </div>
              </section>
            </div>
          </div>

          {error && <p className="callout callout-danger" role="alert">{error}</p>}

          {/* Delete is kept apart from everyday settings, at the very bottom of the page; it cannot be deleted while the instance is not stopped, and the reason is written in this row. */}
          <section className="form-section">
            <h3 className="form-section-title">{t('instance.settings.section.danger')}</h3>
            <div className="list-group">
              <div className="list-row">
                <div className="list-row-text">
                  <p className="list-row-title">{t('dashboard.row.menu.delete')}</p>
                  <p className="list-row-desc" id="instance-settings-delete-desc">
                    {alive ? t('dashboard.row.menu.deleteRunning') : t('instance.settings.delete.desc')}
                  </p>
                </div>
                <div className="list-row-control">
                  <button
                    className="btn btn-danger"
                    type="button"
                    disabled={alive || saving}
                    aria-describedby="instance-settings-delete-desc"
                    onClick={() => setDeleteOpen(true)}
                  >
                    <Trash2 size={14} aria-hidden="true" />
                    {t('dashboard.row.menu.delete')}
                  </button>
                </div>
              </div>
            </div>
          </section>

          <SaveBar
            dirtyCount={changed.length}
            saving={saving}
            saveLabel={t('instance.settings.save')}
            invalidLabel={invalidLabel}
            onFixInvalid={revealInvalid}
            onDiscard={discard}
            notice={savedNotice.notice}
            savedLabel={t('instance.settings.status.saved')}
            restart={restart}
            onDismissNotice={savedNotice.clear}
          />
        </form>
      </FormFeedbackProvider>

      <UnsavedChangesDialog
        blocker={blocker}
        saving={saving}
        title={t('instance.settings.unsaved.title')}
        savingTitle={t('instance.settings.unsaved.savingTitle')}
        description={t('instance.settings.unsaved.description')}
      />

      <DeleteInstanceDialog
        instance={deleteOpen ? instance : null}
        onDeleted={onDeleted}
        onCancel={() => setDeleteOpen(false)}
      />
    </>
  );
}

/** Tab name for an instance sub-route, used in the browser tab title; unknown sub-routes are redirected back to the console. */
const TAB_TITLE_KEYS = new Map<string, MessageKey>([
  ['', 'instance.tab.console'],
  ['files', 'instance.tab.files'],
  ['config', 'instance.tab.properties'],
  ['backups', 'instance.tab.backups'],
  ['settings', 'instance.tab.settings'],
]);

const hubTabClass = ({ isActive }: { isActive: boolean }) => `hub-tab${isActive ? ' active' : ''}`;

export function InstancePage() {
  const { t } = useI18n();
  const { id = '', '*': subPath = '' } = useParams();
  const [instance, setInstance] = useState<InstanceInfo | null>(null);
  const [loadError, setLoadError] = useState('');
  const [confirmRestart, setConfirmRestart] = useState(false);
  const [confirmForceStop, setConfirmForceStop] = useState(false);
  const [deleted, setDeleted] = useState(false);
  // Incremented on each confirmed restart: the "takes effect after restarting the instance" notice in the save bar collapses based on it.
  const [restartSignal, setRestartSignal] = useState(0);

  const load = useCallback(async () => {
    try {
      setInstance(await api<InstanceInfo>(instanceApi(id)));
      setLoadError('');
    } catch (err) {
      setLoadError(errorMessage(err));
    }
  }, [id]);
  usePolling(load);

  // After scrolling the top bar shows the instance name, which says more about which instance is being edited than "Instance Workspace".
  useToolbarTitle(instance?.name ?? null);
  const tabTitleKey = TAB_TITLE_KEYS.get(subPath.replace(/\/+$/, ''));
  useDocumentTitle(
    !instance
      ? t('shell.pageTitle.workspace')
      : instance.requiresMigration || !tabTitleKey
        ? instance.name
        : t('shell.docTitle.instance', { tab: t(tabTitleKey), name: instance.name }),
  );

  const { busyId, error: actionError, run } = useInstanceAction(load);
  const busy = busyId !== null;
  const error = actionError || loadError;

  function act(action: InstanceAction, options?: { force?: boolean }) {
    void run(id, () => controlInstance(id, action, options));
  }

  /** The user clicked "Accept and Start" in the notice: acceptance is recorded first, and on start the panel writes eula.txt based on it. */
  function agreeEulaAndStart() {
    void run(id, async () => {
      await api(instanceApi(id), { method: 'PATCH', json: { acceptEula: true } });
      await controlInstance(id, 'start');
    });
  }

  // The instance is deleted: the whole page is replaced by a redirect. The settings form unmounts with it, so unsaved changes no longer prompt "save before leaving".
  if (deleted) return <Navigate to="/" replace />;

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

  // The restart entry used by the save bars of the config editor and instance settings: the same confirmation dialog and the same disabling conditions as the restart button in the page header.
  const restart: RestartControl = {
    running: instance.status === 'running',
    disabled: busy || instance.requiresMigration || isLifecycleBusy(instance.status),
    signal: restartSignal,
    request: () => setConfirmRestart(true),
  };

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
              {/* Same form as the overview list: core name plus game version, with "Custom Jar" for a custom jar. */}
              <span>
                {coreDisplayName(instance.coreType, t)}
                {instance.mcVersion ? ` ${instance.mcVersion}` : ''}
              </span>
            </div>
          </div>

          {/* Only what can be done in the current state: just "Start" while stopped; stop and restart only while the process is still there, with force stop tucked into "⋯".
              For an instance pending migration, handle the migration notice below first; no buttons go here. */}
          {!instance.requiresMigration && (
            <div className="instance-actions">
              {canStartInstance(instance.status) && (
                <button className="btn btn-ok" type="button" disabled={busy} onClick={() => act('start')}>
                  <Play size={14} aria-hidden="true" />
                  {t('action.start')}
                </button>
              )}
              {canStopInstance(instance.status) && (
                <button className="btn btn-danger" type="button" disabled={busy} onClick={() => act('stop')}>
                  <Power size={14} aria-hidden="true" />
                  {t('action.stop')}
                </button>
              )}
              {isProcessAlive(instance.status) && (
                <>
                  <button
                    className="btn"
                    type="button"
                    disabled={busy || isLifecycleBusy(instance.status)}
                    onClick={() => setConfirmRestart(true)}
                  >
                    <RotateCcw size={14} aria-hidden="true" />
                    {t('action.restart')}
                  </button>
                  <ActionMenu
                    items={[
                      {
                        key: 'force-stop',
                        label: t('action.forceStop'),
                        icon: <Power size={14} />,
                        danger: true,
                        disabled: busy,
                        onSelect: () => setConfirmForceStop(true),
                      },
                    ]}
                  />
                </>
              )}
            </div>
          )}
        </div>
      </header>

      {error && <p className="callout callout-danger" role="alert">{error}</p>}

      {/* The instance's pages use underlined text tabs rather than a capsule segmented control: segmented controls are reserved for "the same content in another view". */}
      {!instance.requiresMigration && (
        <nav className="hub-tabs" aria-label={t('instance.tabs.label')}>
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
          <NavLink to={`/instances/${id}/backups`} className={hubTabClass}>
            <Archive size={15} aria-hidden="true" />
            <span>{t('instance.tab.backups')}</span>
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
            <Route
              index
              element={<ConsoleTab instance={instance} busy={busy} onAgreeEulaAndStart={agreeEulaAndStart} />}
            />
            <Route path="files" element={<FilesTab instanceId={instance.id} />} />
            <Route path="config" element={<ConfigTab instanceId={instance.id} mcVersion={instance.mcVersion} restart={restart} />} />
            <Route path="backups" element={<BackupsTab instance={instance} onRestored={() => void load()} />} />
            <Route
              path="settings"
              element={<SettingsTab instance={instance} restart={restart} onSaved={load} onDeleted={() => setDeleted(true)} />}
            />
            <Route path="multiplayer" element={<Navigate to={`/multiplayer?instance=${encodeURIComponent(id ?? '')}`} replace />} />
            <Route path="*" element={<Navigate to={`/instances/${id}`} replace />} />
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
          setRestartSignal((value) => value + 1);
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
