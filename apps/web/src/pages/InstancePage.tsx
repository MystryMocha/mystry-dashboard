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
  TriangleAlert,
} from 'lucide-react';
import type { InstanceInfo } from '@mystry/shared';
import { api, controlInstance, instanceApi, type InstanceAction } from '../api';
import { BackupsTab } from '../components/BackupsTab';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { ConfigTab } from '../components/ConfigTab';
import { ConsolePanel } from '../components/ConsolePanel';
import { CoreIcon, coreDisplayName } from '../components/CoreIcon';
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
  // 提示只放在控制台页：实例设置页有自己的 EULA 勾选草稿，两处同时改会互相覆盖。
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

/** 和加载时不一样的设置项；保存栏据此写「N 项修改未保存」。 */
function changedSettings(left: SettingsDraft, right: SettingsDraft): (keyof SettingsDraft)[] {
  return SETTINGS_KEYS.filter((key) => left[key] !== right[key]);
}

function SettingsTab({
  instance,
  restart,
  onSaved,
}: {
  instance: InstanceInfo;
  /** 实例页的重启入口：实例在运行时，保存后的提示里给出「重启实例」。 */
  restart: RestartControl;
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
  const feedback = useFormFeedback();
  const savedNotice = useSavedNotice(restart);
  const formRef = useRef<HTMLFormElement>(null);
  const draft: SettingsDraft = { name, jarFile, jvmArgs, acceptEula, javaRuntimeId };
  const changed = changedSettings(draft, originalSettings);
  const dirty = changed.length > 0;
  const blocker = useUnsavedGuard(dirty, saving);
  // 这里改的是已有的名称，清空算填错（失焦后说明原因），和新建表单里「还没填」不是一回事。
  const nameIssue = instanceNameIssue(name);
  // 只在用户改过 Jar 文件名时检查，库里原有的值不拦其他设置的保存。
  const jarFileIssue: Issue | null = jarFile !== originalSettings.jarFile && jarFile.trim() === '' ? { key: 'validation.jarFile.required' } : null;
  // 保存栏点名第一个要改的字段，顺序和页面上的一致。
  const invalidLabel = nameIssue ? t('validation.fixField', { field: t('instance.settings.name.label') })
    : jarFileIssue ? t('validation.fixField', { field: t('instance.settings.jarFile.label') })
      : jvmValid ? null : t('validation.jvm.invalid');
  const invalid = invalidLabel !== null;

  async function save() {
    if (!dirty || saving || invalid) return;
    setSaving(true);
    savedNotice.clear();
    try {
      await api(instanceApi(instance.id), {
        method: 'PATCH',
        json: draft,
      });
      setError('');
      setOriginalSettings(draft);
      feedback.reset();
      // 名称改了立即生效；Jar、Java、JVM 参数和 EULA 只在启动时读取，实例在运行就要重启。
      savedNotice.show(changed.some((key) => key !== 'name'));
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  /** 让各字段显示错误原因，并跳到第一个要改的字段；按 Enter 提交不了和点保存栏的状态文字是同一个动作。 */
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
    feedback.reset();
    setError('');
  }

  return (
    <>
      <FormFeedbackProvider value={feedback.value}>
        {/* noValidate：校验由页面自己做，不让浏览器的原生提示拦住提交。 */}
        <form
          ref={formRef}
          className="form-stack settings-workspace"
          noValidate
          {...formSubmit}
        >
          {/* 宽屏时左栏基本信息与许可协议，右栏运行环境；窄屏按原顺序上下排列。 */}
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
                  {/* JVM 配置器自己显示错误；这层容器不参与排版，只让「跳到要改的字段」能落到它里面。 */}
                  <div className="form-fields" data-field-invalid={jvmValid ? undefined : ''}>
                    <JvmSettingsEditor
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
    </>
  );
}

/** 实例子路由对应的标签名，用于浏览器标签标题；未知子路由会被重定向回控制台。 */
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
  // 每确认一次重启加一：保存栏里「重启实例后生效」的提示据此收起。
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

  // 滚动后顶栏显示实例名，比「实例工作台」更能说明正在改哪个实例。
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

  /** 用户在提示里点了「同意并启动」：先记下同意，启动时面板会据此写入 eula.txt。 */
  function agreeEulaAndStart() {
    void run(id, async () => {
      await api(instanceApi(id), { method: 'PATCH', json: { acceptEula: true } });
      await controlInstance(id, 'start');
    });
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

  // 参数配置和实例设置的保存栏用的重启入口：和页头的重启按钮走同一个确认框、同一套禁用条件。
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
              {/* 与总览列表同一写法：核心名加游戏版本，自定义 jar 显示「自定义 Jar」。 */}
              <span>
                {coreDisplayName(instance.coreType, t)}
                {instance.mcVersion ? ` ${instance.mcVersion}` : ''}
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

      {/* 实例的几个页面用下划线文字标签，不用胶囊分段：分段控件留给「同一份内容换个视图」的场合。 */}
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
            <Route path="settings" element={<SettingsTab instance={instance} restart={restart} onSaved={load} />} />
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
