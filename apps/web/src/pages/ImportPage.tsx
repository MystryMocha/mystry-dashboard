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

/** folder：浏览器选文件夹上传；zip：上传 ZIP；directory：从 imports 交接区复制。 */
type ImportMode = 'folder' | 'directory' | 'zip';

const IMPORT_PREVIEW_SESSION_KEY = 'mystry_import_preview_id';
const FOLDER_UPLOAD_SESSION_KEY = 'mystry_folder_upload_id';
/** 进页面和换来源后的 JVM 参数；JVM 配置器挂载时会换成按本机内存推荐的大小。 */
const DEFAULT_JVM_ARGS = '-Xms1G -Xmx2G';
/** 「修改设置」里的问题持续多久才自动展开，见下方 effect。 */
const AUTO_OPEN_DELAY_MS = 300;

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

function clearStoredFolderUpload() {
  sessionStorage.removeItem(FOLDER_UPLOAD_SESSION_KEY);
}

function isGoneError(err: unknown): boolean {
  return err instanceof ApiError && [404, 410].includes(err.status);
}

export function ImportPage() {
  const navigate = useNavigate();
  const { t, tm, fmt } = useI18n();
  // 选不了文件夹的浏览器（大多是手机）不显示「上传文件夹」，默认仍是 imports 交接区。
  const [folderPickSupported] = useState(canPickFolder);
  const [mode, setMode] = useState<ImportMode>(() => (folderPickSupported ? 'folder' : 'directory'));
  // 点过「上传文件夹」下方的链接后，「从 imports 文件夹复制」一直留在方式切换里，切走再切回来不会消失。
  const [importsRevealed, setImportsRevealed] = useState(false);
  // 默认实例名按进入页面时的界面语言生成，之后由用户自行修改。
  const [name, setName] = useState(() => t('import.form.name.default'));
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<ImportPreviewInfo | null>(null);
  const [restoringPreview, setRestoringPreview] = useState(true);
  // 浏览器上传文件夹：选好还没上传的文件夹、上传并检查后的结果、上传中的进度。
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
  // 整份换掉参数（沿用或取消检测结果）时加一，让 JVM 配置器重新挂载：
  // 回到默认参数时推荐内存重新套用，内存框里没填完的文本也一并丢掉。
  const [jvmEpoch, setJvmEpoch] = useState(0);
  // 当前 JVM 参数是否来自检测到的 user_jvm_args.txt（沿用后用户又改过也算）。
  const jvmFromDetectionRef = useRef(false);
  // 自动沿用之前的参数（用户自己填的或默认值）：点「取消」或换到别的来源时还原成它。
  const jvmBeforeDetectionRef = useRef(DEFAULT_JVM_ARGS);
  // 下面的 effect 和回调要读最新参数，又不该因为参数变化而重跑。
  const jvmArgsRef = useRef(jvmArgs);
  jvmArgsRef.current = jvmArgs;
  const [detectedApplied, setDetectedApplied] = useState(false);
  const [javaRuntimeId, setJavaRuntimeId] = useState<string | null>(null);
  const [javaMajor, setJavaMajor] = useState<number | null>(null);
  // 实际要用的 Java 现在的情况，摘要和「修改设置」自动展开用；设置区没挂载时为 null。
  const [javaState, setJavaState] = useState<JavaResolvedState | null>(null);
  const [jvmValid, setJvmValid] = useState(true);
  // JVM 配置器里有错误、警告，或检测到的 user_jvm_args.txt 用不了。
  const [jvmAttention, setJvmAttention] = useState(false);
  // 「修改设置」折叠区：默认收起，里面有要处理的问题时自动展开（每个来源一次，用户之后仍能收起）。
  const [settingsOpen, setSettingsOpen] = useState(false);
  const autoOpenedForRef = useRef<string | null>(null);
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

  useEffect(() => {
    // 刷新页面后恢复已上传并检查过、等待确认的文件夹；上传到一半的会话已经续不上，直接删掉。
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
  // 上传并检查过、能导入的文件夹的预检结果。
  const folderCheck = folderUpload?.state === 'ready' && folderUpload.check?.ready ? folderUpload.check : null;
  const detectedJvmConfig = mode === 'directory'
    ? selectedSource?.detectedJvmConfig
    : mode === 'zip' ? preview?.detectedJvmConfig : folderCheck?.detectedJvmConfig;
  function selectZip(selected: File | null) {
    if (busy || restoringPreview || !selected) return;
    if (!selected.name.toLowerCase().endsWith('.zip')) {
      setError(t('import.error.notZip'));
      return;
    }
    setError('');
    setFile(selected);
  }

  // 选好来源之前只显示来源区；imports 里也要先选中一个能导入的文件夹。
  const configurationVisible = (mode === 'directory' && Boolean(selectedSource?.ready))
    || (mode === 'zip' && preview !== null)
    || (mode === 'folder' && folderCheck !== null);
  const nameIssue = instanceNameIssue(name);
  // 这一步是上传（ZIP 或文件夹）而不是确认导入：只需要选好文件，不检查名称和 JVM 参数。
  const isUploadStep = (mode === 'zip' && file !== null) || (mode === 'folder' && folder !== null);
  // 确认导入这一步（选好了 imports 里的服务端，或 ZIP、文件夹已上传并检查）才需要名称和 JVM 参数。
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

  // 识别出核心和版本的来源：imports 里选中的文件夹，或上传并检查过的文件夹。
  const recognized = mode === 'directory' ? (selectedSource?.ready ? selectedSource : null)
    : mode === 'folder' ? folderCheck : null;
  useEffect(() => {
    // 识别结果只属于当前来源。ZIP 的核心和版本由服务端在导入时识别，这里回到「没选」，
    // 否则进页面时自动选中的那个文件夹的核心和版本会留在表单里，被当成用户的选择提交上去。
    if (mode === 'zip' || (mode === 'folder' && !recognized)) {
      setCoreType('custom');
      setMcVersion('');
      return;
    }
    if (!recognized) return;
    setCoreType(recognized.coreType);
    // 从文件名认出的版本先填上，Java 选择处才能提前提示版本是否合适；用户仍可改。
    setMcVersion(recognized.mcVersion ?? '');
  }, [mode, selectedSource?.id, folderUpload?.id, recognized?.coreType, recognized?.mcVersion, Boolean(recognized)]);

  /** 沿用检测到的参数，记下沿用之前的参数供「取消」还原。 */
  function applyDetectedJvmArgs(before: string, detectedArgs: string) {
    jvmBeforeDetectionRef.current = before;
    jvmFromDetectionRef.current = true;
    setJvmArgs(detectedArgs);
    setDetectedApplied(true);
    setJvmEpoch((epoch) => epoch + 1);
  }

  /** 不再沿用检测到的参数，还原成沿用之前的参数。 */
  function restoreJvmArgs(before: string) {
    jvmFromDetectionRef.current = false;
    setJvmArgs(before);
    setDetectedApplied(false);
    setJvmEpoch((epoch) => epoch + 1);
  }

  const detectedJvmArgs = detectedJvmConfig?.canonicalArgs ?? null;
  useEffect(() => {
    // 检测结果只属于当前来源。换来源、换模式、换 ZIP 预检（或同一来源的文件变了）后，
    // 先把上一个来源带来的参数还原成沿用之前的参数；新来源有可用的 user_jvm_args.txt 时自动沿用它。
    // 用户没用检测结果、自己填的参数和来源无关，换到没有检测结果的来源时保留。
    const before = jvmFromDetectionRef.current ? jvmBeforeDetectionRef.current : jvmArgsRef.current;
    if (detectedJvmArgs) applyDetectedJvmArgs(before, detectedJvmArgs);
    else if (jvmFromDetectionRef.current) restoreJvmArgs(before);
    else setDetectedApplied(false);
  }, [mode, preview?.id, selectedSource?.id, folderUpload?.id, detectedJvmArgs]);

  // 设置区卸载后它报上来的状态就过期了，清掉，免得下次挂载时用旧状态判断要不要展开。
  useEffect(() => {
    if (configurationVisible) return;
    setJavaState(null);
    setJvmAttention(false);
  }, [configurationVisible]);

  // 换了来源就重新收起，新来源有问题时再自动展开一次。
  const sourceKey = mode === 'directory' ? `directory:${sourceId}`
    : mode === 'zip' ? `zip:${preview?.id ?? ''}` : `folder:${folderUpload?.id ?? ''}`;
  useEffect(() => {
    setSettingsOpen(false);
    autoOpenedForRef.current = null;
  }, [sourceKey]);

  // Java 还在读时 JVM 配置器会因为不知道 Java 版本给出警告，读完再判断。
  const javaSettled = javaState !== null && javaState.availability !== 'loading';
  const javaProblem = javaSettled && (javaState.availability !== 'ready' || javaState.matchStatus === 'mismatch');
  const settingsNeedAttention = configurationVisible
    && (javaInstalling || (javaSettled && (javaProblem || jvmAttention || !jvmValid)));
  useEffect(() => {
    if (!settingsNeedAttention || autoOpenedForRef.current === sourceKey) return;
    // 问题持续一小会儿才展开：换来源、自动选 Java 的那一两次渲染里，核心版本或 Java 还是旧的，
    // 看起来像「版本不符」，其实马上就对了。
    const timer = window.setTimeout(() => {
      autoOpenedForRef.current = sourceKey;
      setSettingsOpen(true);
    }, AUTO_OPEN_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [settingsNeedAttention, sourceKey]);

  const coreLabel = coreTypeOptions.find((option) => option.value === coreType)?.label ?? '';
  // ZIP 的核心和版本在导入时由服务端识别；自己选了核心就按选的写。
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

  /** 不要已经上传并检查过的文件夹了：删掉面板上的临时文件夹，回到选文件夹。 */
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

  // 「从 imports 文件夹复制」是次要入口：浏览器能选文件夹时，只有 imports 里已经放了东西、
  // 当前正处在这个方式，或用户点了「上传文件夹」下方的链接，才出现在方式切换里。
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
        {/* 宽屏时分左右两栏：左栏来源，右栏导入设置；还没选好来源时只有来源一栏。窄屏按原顺序上下排列。 */}
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
                      {/* 未选文件时不放提示：「限制由面板配置决定」说不出具体限制，只是占位的话。 */}
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

                  {/* 面板识别出、准备使用的设置，一行一项；要改的在下面的「修改设置」里。 */}
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
                  </dl>

                  {/*
                    收起时里面的控件照常挂载：Java 自动选择、推荐内存和参数检查都在里面跑，
                    不能改成展开才渲染。
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
