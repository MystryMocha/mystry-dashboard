import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { FileArchive, FolderInput, FolderOpen, FolderUp } from 'lucide-react';
import {
  inspectJvmArgs,
  type CoreType,
  type ExistingServerSourceInfo,
  type FolderUploadInfo,
  type ImportPreviewInfo,
  type TaskInfo,
} from '@mystry/shared';
import {
  ApiError,
  api,
  cancelFolderUpload,
  cancelImportPreview,
  confirmFolderUpload,
  confirmImportPreview,
  createImportPreview,
  getFolderUpload,
  getImportPreview,
  listExistingServerSources,
  pollTask,
} from '../api';
import { EulaCheckbox } from '../components/EulaCheckbox';
import { FolderUploadSection } from '../components/FolderUploadSection';
import { ImportsSourceSection } from '../components/ImportsSourceSection';
import {
  FolderFileUnreadableError,
  FolderUploadInterruptedError,
  canPickFolder,
  uploadFolder,
  type FolderUploadProgress,
  type SelectedFolder,
} from '../folder-upload';
import { JavaRuntimeSelect, type JavaResolvedState } from '../components/JavaRuntimeSelect';
import { JvmSettingsEditor } from '../components/JvmSettingsEditor';
import { PageHeader } from '../components/PageHeader';
import { TaskProgress } from '../components/TaskProgress';
import { errorMessage, isAbortError } from '../errors';
import { useI18n, type MessageKey } from '../i18n';
import { instanceNameIssue, type Issue } from '../validation';

/** folder: upload a folder picked in the browser; zip: upload a ZIP; directory: copy from the imports handoff area. */
type ImportMode = 'folder' | 'directory' | 'zip';

const IMPORT_PREVIEW_SESSION_KEY = 'mystry_import_preview_id';
const FOLDER_UPLOAD_SESSION_KEY = 'mystry_folder_upload_id';
/** JVM arguments on entering the page and after changing the source; when the JVM configurator mounts it replaces them with the size recommended for this machine's memory. */
const DEFAULT_JVM_ARGS = '-Xms1G -Xmx2G';
/** How long a problem in "Edit Settings" has to persist before auto-expanding; see the effect below. */
const AUTO_OPEN_DELAY_MS = 300;

// Core names are technical terms and not translated; only "Auto-detect" stores a string key, resolved in the current language at render time. The submitted custom is replaced by the server with the detection result.
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

function clearStoredFolderUpload() {
  sessionStorage.removeItem(FOLDER_UPLOAD_SESSION_KEY);
}

function isGoneError(err: unknown): boolean {
  return err instanceof ApiError && [404, 410].includes(err.status);
}

export function ImportPage() {
  const navigate = useNavigate();
  const { t, tm, fmt } = useI18n();
  // Browsers that cannot pick folders (mostly phones) do not show "Upload Folder", and the default remains the imports handoff area.
  const [folderPickSupported] = useState(canPickFolder);
  const [mode, setMode] = useState<ImportMode>(() => (folderPickSupported ? 'folder' : 'directory'));
  // After the link below "Upload Folder" has been clicked, "Copy from the imports folder" stays in the mode switcher and does not vanish when switching away and back.
  const [importsRevealed, setImportsRevealed] = useState(false);
  // The default instance name is generated in the UI language at the time the page is entered, and the user changes it afterwards.
  const [name, setName] = useState(() => t('import.form.name.default'));
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<ImportPreviewInfo | null>(null);
  const [restoringPreview, setRestoringPreview] = useState(true);
  // Browser folder upload: the folder picked but not uploaded yet, the result after upload and check, and the progress while uploading.
  const [folder, setFolder] = useState<SelectedFolder | null>(null);
  const [folderUpload, setFolderUpload] = useState<FolderUploadInfo | null>(null);
  const [folderProgress, setFolderProgress] = useState<FolderUploadProgress | null>(null);
  const [restoringFolder, setRestoringFolder] = useState(true);
  const [sources, setSources] = useState<ExistingServerSourceInfo[]>([]);
  const [sourceId, setSourceId] = useState('');
  const [importDir, setImportDir] = useState<string | null>(null);
  const [sourcesLoading, setSourcesLoading] = useState(true);
  const [sourcesError, setSourcesError] = useState('');
  const [coreType, setCoreType] = useState<CoreType>('custom');
  const [mcVersion, setMcVersion] = useState('');
  const [jvmArgs, setJvmArgs] = useState(DEFAULT_JVM_ARGS);
  // Incremented when the arguments are replaced wholesale (adopting or cancelling the detection result), so the JVM configurator remounts:
  // on returning to the default arguments the recommended memory is applied again, and unfinished text in the memory box is dropped too.
  const [jvmEpoch, setJvmEpoch] = useState(0);
  // Whether the current JVM arguments come from the detected user_jvm_args.txt (also counts when the user edited them after adopting).
  const jvmFromDetectionRef = useRef(false);
  // The arguments from before the automatic adoption (the user's own or the defaults): restored on "Cancel" or on switching to another source.
  const jvmBeforeDetectionRef = useRef(DEFAULT_JVM_ARGS);
  // The effects and callbacks below need to read the latest arguments, but should not rerun because the arguments changed.
  const jvmArgsRef = useRef(jvmArgs);
  jvmArgsRef.current = jvmArgs;
  const [detectedApplied, setDetectedApplied] = useState(false);
  const [javaRuntimeId, setJavaRuntimeId] = useState<string | null>(null);
  const [javaMajor, setJavaMajor] = useState<number | null>(null);
  // The current situation of the Java that will actually be used, for the summary and auto-expanding "Edit Settings"; null when the settings area is not mounted.
  const [javaState, setJavaState] = useState<JavaResolvedState | null>(null);
  const [jvmValid, setJvmValid] = useState(true);
  // The JVM configurator has errors or warnings, or the detected user_jvm_args.txt is unusable.
  const [jvmAttention, setJvmAttention] = useState(false);
  // The "Edit Settings" collapsible section: collapsed by default, auto-expanded when it contains a problem to handle (once per source; the user can still collapse it afterwards).
  const [settingsOpen, setSettingsOpen] = useState(false);
  const autoOpenedForRef = useRef<string | null>(null);
  // The EULA must be checked by the user; when the server's own eula.txt already records acceptance the box is not shown, and the import keeps that record.
  const [acceptEula, setAcceptEula] = useState(false);
  const [error, setError] = useState('');
  const [progress, setProgress] = useState<TaskInfo | null>(null);
  const [busy, setBusy] = useState(false);
  /** One-click Java install in progress: the new Java is selected automatically once installed, and importing is not allowed before then. */
  const [javaInstalling, setJavaInstalling] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  /** Aborts in-progress requests and task polling when the component unmounts, so state is not updated after leaving the page. */
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

  useEffect(() => {
    // After a page refresh, restores a folder that was uploaded and checked and is waiting for confirmation; a session interrupted mid-upload cannot be resumed and is deleted.
    const uploadId = sessionStorage.getItem(FOLDER_UPLOAD_SESSION_KEY);
    if (!uploadId) {
      setRestoringFolder(false);
      return;
    }
    const controller = new AbortController();
    void getFolderUpload(uploadId, controller.signal)
      .then((restored) => {
        if (restored.state === 'ready') {
          setFolderUpload(restored);
          setMode('folder');
          return;
        }
        clearStoredFolderUpload();
        void cancelFolderUpload(restored.id).catch(() => undefined);
      })
      .catch((err) => {
        if (isAbortError(err)) return;
        clearStoredFolderUpload();
        if (!isGoneError(err)) setError(errorMessage(err));
      })
      .finally(() => setRestoringFolder(false));
    return () => controller.abort();
  }, []);

  const loadSources = useCallback(async () => {
    setSourcesLoading(true);
    try {
      const { sources: next, importDir: dir } = await listExistingServerSources();
      setSources(next);
      setImportDir(dir || null);
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
  // Precheck result of a folder that was uploaded and checked and can be imported.
  const folderCheck = folderUpload?.state === 'ready' && folderUpload.check?.ready ? folderUpload.check : null;
  const detectedJvmConfig = mode === 'directory'
    ? selectedSource?.detectedJvmConfig
    : mode === 'zip' ? preview?.detectedJvmConfig : folderCheck?.detectedJvmConfig;
  // The server already agreed in its own eula.txt: the import keeps that record, so the page does not ask again.
  const sourceEulaAccepted = (mode === 'directory'
    ? selectedSource?.eulaAccepted
    : mode === 'zip' ? preview?.eulaAccepted : folderCheck?.eulaAccepted) === true;
  function selectZip(selected: File | null) {
    if (busy || restoringPreview || !selected) return;
    if (!selected.name.toLowerCase().endsWith('.zip')) {
      setError(t('import.error.notZip'));
      return;
    }
    setError('');
    setFile(selected);
  }

  // Only the source area is shown before a source is chosen; in imports too, an importable folder has to be selected first.
  const configurationVisible = (mode === 'directory' && Boolean(selectedSource?.ready))
    || (mode === 'zip' && preview !== null)
    || (mode === 'folder' && folderCheck !== null);
  const nameIssue = instanceNameIssue(name);
  // This step is the upload (ZIP or folder), not confirming the import: only the files need to be chosen, and the name and JVM arguments are not checked.
  const isUploadStep = (mode === 'zip' && file !== null) || (mode === 'folder' && folder !== null);
  // Only the confirm-import step (a server in imports is selected, or the ZIP or folder has been uploaded and checked) needs the name and JVM arguments.
  const confirmStep = mode === 'directory' ? Boolean(selectedSource?.ready)
    : mode === 'zip' ? file === null && preview !== null
      : folder === null && folderCheck !== null;
  const blocker: Issue | null = !confirmStep ? null
    : nameIssue ? nameIssue
      : !jvmValid ? { key: 'validation.jvm.invalid' }
        : javaInstalling ? { key: 'validation.java.installing' }
          : null;
  const canSubmit = !busy
    && !restoringPreview
    && !restoringFolder
    && !javaInstalling
    && (isUploadStep ? true : confirmStep && blocker === null);

  // The source whose core and version were recognized: the folder selected in imports, or the folder uploaded and checked.
  const recognized = mode === 'directory' ? (selectedSource?.ready ? selectedSource : null)
    : mode === 'folder' ? folderCheck : null;
  useEffect(() => {
    // A detection result belongs only to the current source. A ZIP's core and version are recognized by the server at import time, so this goes back to "not chosen",
    // otherwise the core and version of the folder auto-selected on entering the page would stay in the form and be submitted as the user's choice.
    if (mode === 'zip' || (mode === 'folder' && !recognized)) {
      setCoreType('custom');
      setMcVersion('');
      return;
    }
    if (!recognized) return;
    setCoreType(recognized.coreType);
    // The version recognized from the file name is filled in first, so the Java picker can warn early whether the version fits; the user can still change it.
    setMcVersion(recognized.mcVersion ?? '');
  }, [mode, selectedSource?.id, folderUpload?.id, recognized?.coreType, recognized?.mcVersion, Boolean(recognized)]);

  /** Adopts the detected arguments, recording the arguments from before for "Cancel" to restore. */
  function applyDetectedJvmArgs(before: string, detectedArgs: string) {
    jvmBeforeDetectionRef.current = before;
    jvmFromDetectionRef.current = true;
    setJvmArgs(detectedArgs);
    setDetectedApplied(true);
    setJvmEpoch((epoch) => epoch + 1);
  }

  /** Stops adopting the detected arguments and restores the arguments from before adopting. */
  function restoreJvmArgs(before: string) {
    jvmFromDetectionRef.current = false;
    setJvmArgs(before);
    setDetectedApplied(false);
    setJvmEpoch((epoch) => epoch + 1);
  }

  const detectedJvmArgs = detectedJvmConfig?.canonicalArgs ?? null;
  useEffect(() => {
    // A detection result belongs only to the current source. After changing the source, the mode or the ZIP precheck (or when the files of the same source changed),
    // first restore the arguments brought by the previous source to those from before adopting; when the new source has a usable user_jvm_args.txt, adopt it automatically.
    // Arguments the user filled in without using the detection result have nothing to do with the source, and are kept when switching to a source without a detection result.
    const before = jvmFromDetectionRef.current ? jvmBeforeDetectionRef.current : jvmArgsRef.current;
    if (detectedJvmArgs) applyDetectedJvmArgs(before, detectedJvmArgs);
    else if (jvmFromDetectionRef.current) restoreJvmArgs(before);
    else setDetectedApplied(false);
  }, [mode, preview?.id, selectedSource?.id, folderUpload?.id, detectedJvmArgs]);

  // Once the settings area unmounts, the state it reported is stale; clear it so the next mount does not decide whether to expand based on old state.
  useEffect(() => {
    if (configurationVisible) return;
    setJavaState(null);
    setJvmAttention(false);
  }, [configurationVisible]);

  // Collapse again when the source changes, and auto-expand once more if the new source has a problem.
  const sourceKey = mode === 'directory' ? `directory:${sourceId}`
    : mode === 'zip' ? `zip:${preview?.id ?? ''}` : `folder:${folderUpload?.id ?? ''}`;
  useEffect(() => {
    setSettingsOpen(false);
    autoOpenedForRef.current = null;
  }, [sourceKey]);

  // While Java is still being read the JVM configurator warns because it does not know the Java version, so decide after the read finishes.
  const javaSettled = javaState !== null && javaState.availability !== 'loading';
  const javaProblem = javaSettled && (javaState.availability !== 'ready' || javaState.matchStatus === 'mismatch');
  const settingsNeedAttention = configurationVisible
    && (javaInstalling || (javaSettled && (javaProblem || jvmAttention || !jvmValid)));
  useEffect(() => {
    if (!settingsNeedAttention || autoOpenedForRef.current === sourceKey) return;
    // Expand only after the problem persists a short while: in the one or two renders of changing the source and auto-selecting Java, the core version or Java is still the old one,
    // which looks like a "version mismatch" but is about to be correct.
    const timer = window.setTimeout(() => {
      autoOpenedForRef.current = sourceKey;
      setSettingsOpen(true);
    }, AUTO_OPEN_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [settingsNeedAttention, sourceKey]);

  const coreLabel = coreTypeOptions.find((option) => option.value === coreType)?.label ?? '';
  // A ZIP's core and version are recognized by the server at import time; when the user chose a core, write what was chosen.
  const serverSummary = coreType === 'custom'
    ? t('import.summary.serverAuto')
    : mcVersion.trim()
      ? t('import.summary.serverValue', { core: coreLabel, version: mcVersion.trim() })
      : t('import.summary.serverNoVersion', { core: coreLabel });
  const javaSummary = !javaSettled
    ? t('import.summary.checking')
    : javaState.availability === 'unknown'
      ? t('import.summary.javaUnknown')
      : javaState.availability === 'missing'
        ? t('import.summary.javaMissing')
        : javaState.major === null
          ? t('import.summary.javaDefaultNoVersion')
          : t(javaState.systemDefault ? 'import.summary.javaDefault' : 'import.summary.javaValue', { java: javaState.major });
  const maxMemoryMiB = inspectJvmArgs(jvmArgs).xmxMiB;
  const memorySummary = maxMemoryMiB === null
    ? t('import.summary.memoryCustom')
    : t('import.summary.memoryValue', { value: fmt.number(maxMemoryMiB / 1024, { maximumFractionDigits: 2 }) });

  async function cancelPreview() {
    if (!preview) return;
    setBusy(true);
    setError('');
    try {
      await cancelImportPreview(preview.id);
      clearStoredPreview();
      setPreview(null);
      setFile(null);
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

  /** Discards the folder that was uploaded and checked: deletes the temp folder on the panel and goes back to picking a folder. */
  async function discardFolderUpload() {
    if (!folderUpload) return;
    setBusy(true);
    setError('');
    try {
      await cancelFolderUpload(folderUpload.id);
    } catch (err) {
      if (!isGoneError(err)) {
        setError(errorMessage(err));
        return;
      }
    } finally {
      setBusy(false);
    }
    clearStoredFolderUpload();
    setFolderUpload(null);
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
    if (mode === 'folder' && !folder && !folderCheck) {
      setError(t('import.error.noFolder'));
      return;
    }
    if (!isUploadStep && !jvmValid) {
      setError(t('import.error.jvmInvalid'));
      return;
    }
    if (!isUploadStep && blocker) return;

    setBusy(true);
    setError('');
    if (!isUploadStep) setProgress(null);
    const controller = new AbortController();
    pollAbortRef.current = controller;
    try {
      if (isUploadStep && mode === 'zip') {
        const created = await createImportPreview(file!, controller.signal);
        if (controller.signal.aborted) return;
        setPreview(created);
        setFile(null);
        sessionStorage.setItem(IMPORT_PREVIEW_SESSION_KEY, created.id);
        return;
      }
      if (isUploadStep && mode === 'folder') {
        setFolderProgress({ files: 0, bytes: 0, totalFiles: folder!.files.length, totalBytes: folder!.totalBytes, waiting: false });
        try {
          const uploaded = await uploadFolder(folder!, { signal: controller.signal, onProgress: setFolderProgress });
          if (controller.signal.aborted) return;
          setFolderUpload(uploaded);
          setFolder(null);
          sessionStorage.setItem(FOLDER_UPLOAD_SESSION_KEY, uploaded.id);
        } finally {
          setFolderProgress(null);
        }
        return;
      }

      let task: TaskInfo;
      if (mode === 'folder') {
        task = await confirmFolderUpload(folderUpload!.id, {
          name,
          coreType,
          mcVersion: mcVersion || undefined,
          jvmArgs,
          acceptEula,
          javaRuntimeId,
        }, controller.signal);
        clearStoredFolderUpload();
        setFolderUpload(null);
      } else if (mode === 'directory') {
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
      if (mode === 'zip' && isGoneError(err)) {
        clearStoredPreview();
        setPreview(null);
      }
      if (mode === 'folder' && isGoneError(err)) {
        clearStoredFolderUpload();
        setFolderUpload(null);
      }
      setError(err instanceof FolderFileUnreadableError
        ? t('import.folder.unreadable', { path: err.relativePath })
        : err instanceof FolderUploadInterruptedError ? t('import.folder.interrupted') : errorMessage(err));
    } finally {
      if (pollAbortRef.current === controller) pollAbortRef.current = null;
      setBusy(false);
    }
  }

  const submitLabel = t(busy
    ? isUploadStep ? 'import.submit.uploading' : 'import.submit.importing'
    : mode === 'directory'
      ? 'import.submit.copy'
      : mode === 'folder'
        ? folder ? 'import.submit.upload' : folderCheck ? 'import.submit.confirm' : 'import.submit.chooseFolder'
        : file
          ? preview ? 'import.submit.replacePreview' : 'import.submit.upload'
          : preview ? 'import.submit.confirm' : 'import.submit.chooseZip');

  // "Copy from the imports folder" is a secondary entry: when the browser can pick folders, it appears in the mode switcher only when imports already has something in it,
  // this mode is the current one, or the user clicked the link below "Upload Folder".
  const showImportsTab = !folderPickSupported || importsRevealed || mode === 'directory' || sources.length > 0;

  function modeTab(tabMode: ImportMode, icon: ReactNode, label: string) {
    return (
      <button
        type="button"
        className={`segmented-item${mode === tabMode ? ' active' : ''}`}
        aria-pressed={mode === tabMode}
        disabled={busy}
        onClick={() => setMode(tabMode)}
      >
        {icon}
        {label}
      </button>
    );
  }

  return (
    <div className="page import-workspace">
      <PageHeader
        title={t('nav.import')}
        subtitle={t('import.page.subtitle')}
      />

      <div className="segmented import-mode-switch" role="group" aria-label={t('import.mode.ariaLabel')}>
        {folderPickSupported ? (
          <>
            {modeTab('folder', <FolderOpen size={15} aria-hidden="true" />, t('import.mode.folder'))}
            {modeTab('zip', <FileArchive size={15} aria-hidden="true" />, t('import.mode.zip'))}
            {showImportsTab ? modeTab('directory', <FolderInput size={15} aria-hidden="true" />, t('import.mode.directory')) : null}
          </>
        ) : (
          <>
            {modeTab('directory', <FolderInput size={15} aria-hidden="true" />, t('import.mode.directory'))}
            {modeTab('zip', <FileArchive size={15} aria-hidden="true" />, t('import.mode.zip'))}
          </>
        )}
      </div>

      <form className="form-stack import-form" onSubmit={(e) => void onSubmit(e)}>
        {/* On wide screens there are two columns: the source on the left and import settings on the right; before a source is chosen there is only the source column. Narrow screens stack them in the original order. */}
        <div className="form-columns">
          <div className="form-column">
            {mode === 'folder' ? (
              <FolderUploadSection
                folder={folder}
                upload={folderUpload}
                progress={folderProgress}
                restoring={restoringFolder}
                busy={busy}
                onChoose={(next) => {
                  setError('');
                  setFolder(next);
                }}
                onError={setError}
                onCancelUpload={() => pollAbortRef.current?.abort()}
                onDiscard={() => void discardFolderUpload()}
                onUseImports={showImportsTab ? undefined : () => {
                  setError('');
                  setImportsRevealed(true);
                  setMode('directory');
                }}
              />
            ) : mode === 'directory' ? (
              <ImportsSourceSection
                importDir={importDir}
                sources={sources}
                sourceId={sourceId}
                loading={sourcesLoading}
                error={sourcesError}
                busy={busy}
                onSelect={setSourceId}
                onRefresh={() => void loadSources()}
              />
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
                      {/* No hint when no file is chosen: "the limit is decided by panel config" cannot name a specific limit and is only filler. */}
                      {file && (
                        <span className="drop-zone-hint">
                          {t('import.zip.drop.size', { size: fmt.fixed(file.size / 1024 / 1024, 1) })}
                        </span>
                      )}
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
          </div>

          {configurationVisible ? (
            <div className="form-column">
              <section className="form-section">
                <h2 className="form-section-title">{t('import.settings.title')}</h2>
                <div className="card form-card">
                  <div className="field">
                    <label htmlFor="import-instance-name">{t('import.form.name.label')}</label>
                    <input
                      id="import-instance-name"
                      value={name}
                      disabled={busy}
                      aria-invalid={nameIssue ? true : undefined}
                      aria-describedby={nameIssue ? 'import-instance-name-error' : undefined}
                      onChange={(e) => setName(e.target.value)}
                    />
                    {nameIssue && <p className="error" id="import-instance-name-error">{t(nameIssue.key, nameIssue.params)}</p>}
                  </div>

                  {/* The settings the panel recognized and is about to use, one per row; what needs changing is in "Edit Settings" below. */}
                  <dl className="import-summary" aria-label={t('import.summary.ariaLabel')}>
                    <div className="import-summary-row">
                      <dt>{t('import.summary.server')}</dt>
                      <dd>{serverSummary}</dd>
                    </div>
                    <div className="import-summary-row">
                      <dt>{t('import.summary.java')}</dt>
                      <dd>
                        {javaSummary}
                        {javaSettled && javaState.availability === 'ready' && javaState.matchStatus === 'mismatch' && javaState.recommended != null ? (
                          <span className="import-summary-warn">{t('import.summary.javaMismatch', { java: javaState.recommended })}</span>
                        ) : null}
                        {javaSettled && javaState.availability === 'ready' && javaState.recommended == null ? (
                          <span className="import-summary-note">{t('import.summary.javaUnverified')}</span>
                        ) : null}
                      </dd>
                    </div>
                    <div className="import-summary-row">
                      <dt>{t('import.summary.memory')}</dt>
                      <dd>
                        {memorySummary}
                        {detectedApplied && detectedJvmConfig ? (
                          <span className="import-summary-note">{t('import.summary.memoryFromFile', { source: detectedJvmConfig.source })}</span>
                        ) : null}
                      </dd>
                    </div>
                    {sourceEulaAccepted ? (
                      <div className="import-summary-row">
                        <dt>{t('import.summary.eula')}</dt>
                        <dd>
                          {t('import.summary.eulaAccepted')}
                          <span className="import-summary-note">{t('import.summary.eulaFromFile')}</span>
                        </dd>
                      </div>
                    ) : null}
                  </dl>

                  {/*
                    The controls inside stay mounted while collapsed: Java auto-selection, recommended memory and argument checks all run in there,
                    so it cannot be changed to render only when expanded.
                  */}
                  <details
                    className="disclosure import-settings-more"
                    open={settingsOpen}
                    onToggle={(event) => setSettingsOpen(event.currentTarget.open)}
                  >
                    <summary>{t('import.settings.more')}</summary>
                    <div className="import-settings-body">
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
                      <JavaRuntimeSelect
                        value={javaRuntimeId}
                        onChange={setJavaRuntimeId}
                        onResolvedMajorChange={setJavaMajor}
                        onResolvedChange={setJavaState}
                        mcVersion={mcVersion}
                        disabled={busy}
                        autoSelect
                        onInstallingChange={setJavaInstalling}
                      />
                      <JvmSettingsEditor
                        key={jvmEpoch}
                        value={jvmArgs}
                        onChange={setJvmArgs}
                        coreType={coreType}
                        javaMajor={javaMajor}
                        disabled={busy}
                        useRecommendedDefault
                        detectedJvmConfig={detectedJvmConfig}
                        detectedApplied={detectedApplied}
                        onDetectedAppliedChange={(applied) => {
                          if (!applied) restoreJvmArgs(jvmBeforeDetectionRef.current);
                          else if (detectedJvmArgs) applyDetectedJvmArgs(jvmArgsRef.current, detectedJvmArgs);
                        }}
                        onValidityChange={setJvmValid}
                        onAttentionChange={setJvmAttention}
                      />
                    </div>
                  </details>

                  {!sourceEulaAccepted && <EulaCheckbox checked={acceptEula} disabled={busy} onChange={setAcceptEula} />}
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
              ? isUploadStep
                ? t(mode === 'folder' ? 'import.status.folderUploading' : 'import.status.uploading')
                : t('import.status.background')
              : blocker ? t(blocker.key, blocker.params)
              : mode === 'directory'
                ? selectedSource?.ready ? t('import.status.willCopy', { id: selectedSource.id }) : t('import.status.chooseSource')
                : mode === 'folder'
                  ? folderCheck && !folder ? t('import.status.folderReady') : t('import.status.chooseFolder')
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
