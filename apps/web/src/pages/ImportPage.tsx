import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { FileArchive, FolderInput, FolderUp, Info, RefreshCw } from 'lucide-react';
import type { CoreType, ExistingServerSourceInfo, ImportPreviewInfo, TaskInfo } from '@mystry/shared';
import {
  ApiError,
  api,
  cancelImportPreview,
  confirmImportPreview,
  createImportPreview,
  getImportPreview,
  listExistingServerSources,
  pollTask,
} from '../api';
import { EulaCheckbox } from '../components/EulaCheckbox';
import { JavaRuntimeSelect } from '../components/JavaRuntimeSelect';
import { JvmSettingsEditor, type DetectedJvmChoice } from '../components/JvmSettingsEditor';
import { PageHeader } from '../components/PageHeader';
import { TaskProgress } from '../components/TaskProgress';
import { errorMessage, isAbortError } from '../errors';
import { useI18n, type MessageKey } from '../i18n';

type ImportMode = 'directory' | 'zip';

const IMPORT_PREVIEW_SESSION_KEY = 'mystry_import_preview_id';

// 核心名是技术名词不翻译；只有「自动识别」存文案键，渲染时再取当前语言。提交的 custom 由服务端按识别结果替换。
const coreTypeOptions: Array<{ value: CoreType; label: string; labelKey?: MessageKey }> = [
  { value: 'custom', label: '', labelKey: 'import.form.coreType.auto' },
  { value: 'paper', label: 'Paper' },
  { value: 'fabric', label: 'Fabric' },
  { value: 'forge', label: 'Forge' },
  { value: 'neoforge', label: 'NeoForge' },
  { value: 'vanilla', label: 'Vanilla' },
];

function clearStoredPreview() {
  sessionStorage.removeItem(IMPORT_PREVIEW_SESSION_KEY);
}

export function ImportPage() {
  const navigate = useNavigate();
  const { t, tm, rich, fmt } = useI18n();
  const [mode, setMode] = useState<ImportMode>('directory');
  // 默认实例名按进入页面时的界面语言生成，之后由用户自行修改。
  const [name, setName] = useState(() => t('import.form.name.default'));
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<ImportPreviewInfo | null>(null);
  const [restoringPreview, setRestoringPreview] = useState(true);
  const [sources, setSources] = useState<ExistingServerSourceInfo[]>([]);
  const [sourceId, setSourceId] = useState('');
  const [sourcesLoading, setSourcesLoading] = useState(true);
  const [sourcesError, setSourcesError] = useState('');
  const [coreType, setCoreType] = useState<CoreType>('custom');
  const [mcVersion, setMcVersion] = useState('');
  const [jvmArgs, setJvmArgs] = useState('-Xms1G -Xmx2G');
  const [javaRuntimeId, setJavaRuntimeId] = useState<string | null>(null);
  const [javaMajor, setJavaMajor] = useState<number | null>(null);
  const [detectedChoice, setDetectedChoice] = useState<DetectedJvmChoice>(null);
  const [jvmValid, setJvmValid] = useState(true);
  // EULA 必须由用户主动勾选同意；已有服务端若自带 eula.txt 同意记录，可保持不勾选。
  const [acceptEula, setAcceptEula] = useState(false);
  const [error, setError] = useState('');
  const [progress, setProgress] = useState<TaskInfo | null>(null);
  const [busy, setBusy] = useState(false);
  /** Java 一键安装进行中：装完会自动选中新 Java，之前不允许导入。 */
  const [javaInstalling, setJavaInstalling] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  /** 组件卸载时中止进行中的请求和任务轮询，避免离开页面后继续更新状态。 */
  const pollAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => pollAbortRef.current?.abort();
  }, []);

  useEffect(() => {
    const previewId = sessionStorage.getItem(IMPORT_PREVIEW_SESSION_KEY);
    if (!previewId) {
      setRestoringPreview(false);
      return;
    }
    const controller = new AbortController();
    void getImportPreview(previewId, controller.signal)
      .then((restored) => {
        setPreview(restored);
        setMode('zip');
      })
      .catch((err) => {
        if (isAbortError(err)) return;
        clearStoredPreview();
        if (!(err instanceof ApiError && [404, 410].includes(err.status))) {
          setError(errorMessage(err));
        }
      })
      .finally(() => setRestoringPreview(false));
    return () => controller.abort();
  }, []);

  const loadSources = useCallback(async () => {
    setSourcesLoading(true);
    try {
      const next = await listExistingServerSources();
      setSources(next);
      setSourceId((current) => {
        if (next.some((source) => source.id === current && source.ready)) return current;
        return next.find((source) => source.ready)?.id ?? '';
      });
      setSourcesError('');
    } catch (err) {
      setSourcesError(errorMessage(err));
    } finally {
      setSourcesLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadSources();
  }, [loadSources]);

  const selectedSource = sources.find((source) => source.id === sourceId) ?? null;
  const detectedJvmConfig = mode === 'directory'
    ? selectedSource?.detectedJvmConfig
    : preview?.detectedJvmConfig;
  function selectZip(selected: File | null) {
    if (busy || restoringPreview || !selected) return;
    if (!selected.name.toLowerCase().endsWith('.zip')) {
      setError(t('import.error.notZip'));
      return;
    }
    setError('');
    setFile(selected);
  }

  const configurationVisible = mode === 'directory' || preview !== null;
  const canSubmit = !busy
    && !restoringPreview
    && !javaInstalling
    && (mode === 'directory'
      ? Boolean(selectedSource?.ready && jvmValid)
      : file !== null || Boolean(preview && jvmValid));

  useEffect(() => {
    if (!selectedSource?.ready) return;
    setCoreType(selectedSource.coreType);
    // 从文件名认出的版本先填上，Java 选择处才能提前提示版本是否合适；用户仍可改。
    setMcVersion(selectedSource.mcVersion ?? '');
  }, [selectedSource?.id, selectedSource?.ready, selectedSource?.coreType, selectedSource?.mcVersion]);

  useEffect(() => {
    setDetectedChoice(null);
  }, [mode, preview?.id, selectedSource?.id]);

  async function cancelPreview() {
    if (!preview) return;
    setBusy(true);
    setError('');
    try {
      await cancelImportPreview(preview.id);
      clearStoredPreview();
      setPreview(null);
      setFile(null);
      setDetectedChoice(null);
    } catch (err) {
      if (err instanceof ApiError && [404, 410].includes(err.status)) {
        clearStoredPreview();
        setPreview(null);
        setFile(null);
        return;
      }
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (mode === 'directory' && !selectedSource?.ready) {
      setError(t('import.error.noSource'));
      return;
    }
    if (mode === 'zip' && !file && !preview) {
      setError(t('import.error.noZip'));
      return;
    }
    const isPreviewUpload = mode === 'zip' && file !== null;
    if (!isPreviewUpload && !jvmValid) {
      setError(t('import.error.jvmInvalid'));
      return;
    }

    setBusy(true);
    setError('');
    if (!isPreviewUpload) setProgress(null);
    const controller = new AbortController();
    pollAbortRef.current = controller;
    try {
      if (isPreviewUpload) {
        const created = await createImportPreview(file, controller.signal);
        if (controller.signal.aborted) return;
        setPreview(created);
        setFile(null);
        setDetectedChoice(null);
        sessionStorage.setItem(IMPORT_PREVIEW_SESSION_KEY, created.id);
        return;
      }

      let task: TaskInfo;
      if (mode === 'directory') {
        task = await api<TaskInfo>('/api/import/existing', {
          method: 'POST',
          signal: controller.signal,
          json: {
            name,
            sourceId,
            coreType,
            mcVersion: mcVersion || undefined,
            jvmArgs,
            acceptEula,
            javaRuntimeId,
          },
        });
      } else {
        task = await confirmImportPreview(preview!.id, {
          name,
          coreType,
          mcVersion: mcVersion || undefined,
          jvmArgs,
          acceptEula,
          javaRuntimeId,
        }, controller.signal);
        clearStoredPreview();
        setPreview(null);
      }

      if (controller.signal.aborted) return;
      setProgress(task);
      const result = await pollTask(task.id, setProgress, controller.signal);
      if (result?.instanceId) navigate(`/instances/${result.instanceId}`);
    } catch (err) {
      if (isAbortError(err)) return;
      if (mode === 'zip' && err instanceof ApiError && [404, 410].includes(err.status)) {
        clearStoredPreview();
        setPreview(null);
      }
      setError(errorMessage(err));
    } finally {
      if (pollAbortRef.current === controller) pollAbortRef.current = null;
      setBusy(false);
    }
  }

  const submitLabel = t(busy
    ? mode === 'zip' && file ? 'import.submit.uploading' : 'import.submit.importing'
    : mode === 'directory'
      ? 'import.submit.copy'
      : file
        ? preview ? 'import.submit.replacePreview' : 'import.submit.upload'
        : preview ? 'import.submit.confirm' : 'import.submit.chooseZip');

  return (
    <div className="page import-workspace">
      <PageHeader
        title={t('nav.import')}
        subtitle={t('import.page.subtitle')}
      />

      <div className="segmented import-mode-switch" role="group" aria-label={t('import.mode.ariaLabel')}>
        <button
          type="button"
          className={`segmented-item${mode === 'directory' ? ' active' : ''}`}
          aria-pressed={mode === 'directory'}
          disabled={busy}
          onClick={() => setMode('directory')}
        >
          <FolderInput size={15} aria-hidden="true" />
          {t('import.mode.directory')}
        </button>
        <button
          type="button"
          className={`segmented-item${mode === 'zip' ? ' active' : ''}`}
          aria-pressed={mode === 'zip'}
          disabled={busy}
          onClick={() => setMode('zip')}
        >
          <FileArchive size={15} aria-hidden="true" />
          {t('import.mode.zip')}
        </button>
      </div>

      <form className="form-stack import-form" onSubmit={(e) => void onSubmit(e)}>
        {/* 宽屏时分左右两栏：左栏来源与实例信息，右栏运行环境与许可协议；窄屏按原顺序上下排列。 */}
        <div className="form-columns">
          <div className="form-column">
            {mode === 'directory' ? (
              <section className="form-section">
                <h2 className="form-section-title">{t('import.directory.title')}</h2>
                <div className="card form-card">
                  <div className="callout callout-info import-handoff-note">
                    <Info size={18} aria-hidden="true" className="callout-icon" />
                    <div>
                      <strong>{t('import.directory.steps.title')}</strong>
                      <ol>
                        <li>{t('import.directory.steps.stop')}</li>
                        <li>
                          {rich('import.directory.steps.copy', { code: (chunk) => <code>{chunk}</code> })}
                        </li>
                        <li>{t('import.directory.steps.select')}</li>
                      </ol>
                      <p>{t('import.directory.steps.note')}</p>
                    </div>
                  </div>
                  <div className="field">
                    <label htmlFor="existing-server-source">{t('import.directory.source.label')}</label>
                    <div className="input-row import-source-row">
                      <select
                        id="existing-server-source"
                        value={sourceId}
                        disabled={busy || sourcesLoading}
                        onChange={(e) => setSourceId(e.target.value)}
                      >
                        <option value="">
                          {sourcesLoading ? t('import.directory.source.loading') : t('import.directory.source.placeholder')}
                        </option>
                        {sources.map((source) => (
                          <option key={source.id} value={source.id} disabled={!source.ready}>
                            {source.ready
                              ? t('import.directory.source.ready', {
                                id: source.id,
                                target: source.launchTarget ?? t('import.directory.source.pendingCheck'),
                              })
                              : t('import.directory.source.unavailable', { id: source.id, error: tm(source.errorI18n, source.error ?? '') })}
                          </option>
                        ))}
                      </select>
                      <button
                        className="btn"
                        type="button"
                        disabled={busy || sourcesLoading}
                        onClick={() => void loadSources()}
                      >
                        <RefreshCw size={14} aria-hidden="true" className={sourcesLoading ? 'spin' : undefined} />
                        {sourcesLoading ? t('import.directory.refreshing') : t('import.directory.refresh')}
                      </button>
                    </div>
                    {!sourcesLoading && sources.length === 0 ? (
                      <p className="field-help">{t('import.directory.empty')}</p>
                    ) : null}
                    {selectedSource?.ready && selectedSource.launchTarget ? (
                      <p className="field-help">
                        {rich(
                          'import.directory.launchTarget',
                          { code: (chunk) => <code>{chunk}</code> },
                          { target: selectedSource.launchTarget },
                        )}
                      </p>
                    ) : null}
                    {selectedSource?.ready && selectedSource.error ? (
                      <p className="field-help">{tm(selectedSource.errorI18n, selectedSource.error)}</p>
                    ) : null}
                    {sourcesError ? <p className="error">{t('import.directory.loadError', { error: sourcesError })}</p> : null}
                  </div>
                </div>
              </section>
            ) : (
              <section className="form-section">
                <h2 className="form-section-title">{t('import.zip.title')}</h2>
                <div className="card form-card">
                  <p className="field-help import-zip-lead">
                    {t('import.zip.lead')}
                  </p>
                  {restoringPreview ? (
                    <p className="field-help" role="status">
                      <span className="spinner spinner-sm" aria-hidden="true" /> {t('import.zip.restoring')}
                    </p>
                  ) : null}
                  {preview ? (
                    <div className="callout callout-success import-preview-card" aria-live="polite">
                      <FileArchive size={18} aria-hidden="true" className="callout-icon" />
                      <div>
                        <strong>{t('import.zip.preview.title')}</strong>
                        <p>
                          {t('import.zip.preview.fileInfo', {
                            name: preview.fileName,
                            size: fmt.fixed(preview.sizeBytes / 1024 / 1024, 1),
                          })}
                        </p>
                        <p>{t('import.zip.preview.expires', { time: fmt.dateTime(preview.expiresAt) })}</p>
                      </div>
                      <button className="btn btn-sm" type="button" disabled={busy} onClick={() => void cancelPreview()}>
                        {t('import.zip.preview.cancel')}
                      </button>
                    </div>
                  ) : null}

                  <div className="field">
                    <label htmlFor="existing-server-zip">{t('import.zip.file.label')}</label>
                    <div
                      className={`drop-zone${isDragging ? ' is-dragging' : ''}${file ? ' has-file' : ''}${busy || restoringPreview ? ' is-disabled' : ''}`}
                      onDragOver={(e) => {
                        e.preventDefault();
                        if (!busy && !restoringPreview) setIsDragging(true);
                      }}
                      onDragLeave={() => setIsDragging(false)}
                      onDrop={(e) => {
                        e.preventDefault();
                        setIsDragging(false);
                        if (busy || restoringPreview) return;
                        const dropped = e.dataTransfer.files?.[0];
                        selectZip(dropped ?? null);
                      }}
                    >
                      <span className="drop-zone-icon" aria-hidden="true"><FolderUp size={28} /></span>
                      <div className="drop-zone-title">
                        {file ? file.name : t('import.zip.drop.title')}
                      </div>
                      <span className="drop-zone-hint">
                        {file
                          ? t('import.zip.drop.size', { size: fmt.fixed(file.size / 1024 / 1024, 1) })
                          : t('import.zip.drop.hint')}
                      </span>
                      <button className="btn" type="button" disabled={busy || restoringPreview}
                        onClick={() => document.getElementById('existing-server-zip')?.click()}>
                        {t('import.zip.choose')}
                      </button>
                    </div>
                    <input
                      key={preview?.id ?? 'new-preview'}
                      id="existing-server-zip"
                      type="file"
                      accept=".zip,application/zip"
                      disabled={busy || restoringPreview}
                      hidden
                      onChange={(e) => { selectZip(e.target.files?.[0] ?? null); e.target.value = ''; }}
                    />
                    {preview ? (
                      <p className="field-help">{t('import.zip.replaceHelp')}</p>
                    ) : null}
                  </div>
                </div>
              </section>
            )}

            {configurationVisible ? (
              <section className="form-section">
                <h2 className="form-section-title">{t('import.instance.title')}</h2>
                <div className="card form-card">
                  <div className="field">
                    <label htmlFor="import-instance-name">{t('import.form.name.label')}</label>
                    <input
                      id="import-instance-name"
                      value={name}
                      disabled={busy}
                      maxLength={128}
                      onChange={(e) => setName(e.target.value)}
                      required
                    />
                  </div>
                  <div className="grid grid-2 import-meta-grid">
                    <div className="field">
                      <label htmlFor="import-core-type">{t('import.form.coreType.label')}</label>
                      <select
                        id="import-core-type"
                        value={coreType}
                        disabled={busy}
                        onChange={(e) => setCoreType(e.target.value as CoreType)}
                      >
                        {coreTypeOptions.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.labelKey ? t(option.labelKey) : option.label}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="field">
                      <label htmlFor="import-mc-version">{t('import.form.mcVersion.label')}</label>
                      <input
                        id="import-mc-version"
                        value={mcVersion}
                        disabled={busy}
                        maxLength={64}
                        placeholder={t('import.form.mcVersion.placeholder')}
                        onChange={(e) => setMcVersion(e.target.value)}
                      />
                    </div>
                  </div>
                </div>
              </section>
            ) : null}
          </div>

          {configurationVisible ? (
            <div className="form-column">
              <section className="form-section">
                <h2 className="form-section-title">{t('import.runtime.title')}</h2>
                <div className="card form-card">
                  <JavaRuntimeSelect
                    value={javaRuntimeId}
                    onChange={setJavaRuntimeId}
                    onResolvedMajorChange={setJavaMajor}
                    mcVersion={mcVersion}
                    disabled={busy}
                    autoSelect
                    onInstallingChange={setJavaInstalling}
                  />
                  <JvmSettingsEditor
                    value={jvmArgs}
                    onChange={setJvmArgs}
                    coreType={coreType}
                    javaMajor={javaMajor}
                    disabled={busy}
                    useRecommendedDefault
                    detectedJvmConfig={detectedJvmConfig}
                    detectedChoice={detectedChoice}
                    onDetectedChoiceChange={setDetectedChoice}
                    onValidityChange={setJvmValid}
                  />
                </div>
              </section>

              <section className="form-section">
                <h2 className="form-section-title">{t('import.eula.title')}</h2>
                <div className="card form-card">
                  <EulaCheckbox checked={acceptEula} disabled={busy} onChange={setAcceptEula} />
                </div>
              </section>
            </div>
          ) : null}
        </div>

        {error ? <p className="callout callout-danger" role="alert">{error}</p> : null}
        {progress ? <div className="card form-card"><TaskProgress task={progress} label={t('import.progress.label')} /></div> : null}

        <div className="action-bar">
          <span className="action-bar-status" role="status" aria-live="polite">
            {busy
              ? mode === 'zip' && file ? t('import.status.uploading') : t('import.status.background')
              : mode === 'directory'
                ? selectedSource?.ready ? t('import.status.willCopy', { id: selectedSource.id }) : t('import.status.chooseSource')
                : preview ? t('import.status.previewReady') : t('import.status.uploadFirst')}
          </span>
          <button className="btn btn-primary" type="submit" disabled={!canSubmit}>
            {submitLabel}
          </button>
        </div>
      </form>
    </div>
  );
}
