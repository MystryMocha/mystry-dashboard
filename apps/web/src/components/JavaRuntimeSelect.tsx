import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Download, RefreshCw } from 'lucide-react';
import { recommendedJavaMajor, type JavaDetectResult, type JavaRuntimeInfo, type PanelMessage, type TaskInfo } from '@mystry/shared';
import { cancelJavaInstall, detectDefaultJava, installJavaRuntime, listJavaRuntimes, pollTask } from '../api';
import { errorMessage } from '../errors';
import { useI18n } from '../i18n';
import { javaDownloadUrl } from '../java-download';
import { ConfirmDialog } from './ConfirmDialog';
import { TaskProgress } from './TaskProgress';

/** 接口错误或 pollTask 抛出的任务失败带的服务端消息键。 */
function serverErrorKey(error: unknown): string | undefined {
  return (error as { messageI18n?: PanelMessage } | null)?.messageI18n?.key;
}

/**
 * Java 运行时选择器：
 * - 选项只来自面板探测并已验证的注册表，外加「默认（PATH 中的 java）」。
 * - 传入 mcVersion 时显示推荐版本，所选运行时不匹配给出告警。
 * - autoSelect（只给新建实例用）：用户没手动选过时，自动选中与推荐主版本相同的已装 Java。
 *   实例设置页不开，避免打开页面就悄悄改掉已有实例的 Java。
 * - 推荐版本没装、面板能装时给出「安装 Java N」按钮（D-034），装好后选中它。
 */
/** 实际要用的 Java 是否就是推荐版本：loading 还没读完；版本未知（不推荐）时算 match。 */
/** unknown：Java 列表一次都没读到，不知道装没装、是哪个版本，不能说成「版本不符」。 */
export type JavaMatchStatus = 'loading' | 'match' | 'mismatch' | 'unknown';

/**
 * 实际要用的 Java 现在怎么样，给页面做摘要用。
 * loading：还没读完；unknown：列表一次都没读到；ready：可以用；missing：没装 Java，或所选的已不可用。
 * matchStatus 在不知道 Minecraft 版本时总是 match，分不出「还在读」和「没有 Java」，所以另给这个。
 */
export type JavaResolvedState = {
  availability: 'loading' | 'unknown' | 'ready' | 'missing';
  major: number | null;
  /** 用的是系统默认 Java（PATH 里的 java），不是面板登记的某一个。 */
  systemDefault: boolean;
  matchStatus: JavaMatchStatus;
  /** 当前 Minecraft 版本推荐的主版本；不知道版本时为 null。 */
  recommended: number | null;
};

export function JavaRuntimeSelect({
  value,
  onChange,
  mcVersion,
  disabled = false,
  onResolvedMajorChange,
  autoSelect = false,
  onInstallingChange,
  onMatchStatusChange,
  onResolvedChange,
}: {
  value: string | null;
  onChange: (runtimeId: string | null) => void;
  mcVersion?: string | null;
  disabled?: boolean;
  onResolvedMajorChange?: (major: number | null) => void;
  autoSelect?: boolean;
  /** 一键安装进行中时为 true；页面据此暂停提交，免得用错的 Java 建实例。 */
  onInstallingChange?: (installing: boolean) => void;
  /** 部署页据此在版本不符时禁止开始部署（D-034）。 */
  onMatchStatusChange?: (status: JavaMatchStatus) => void;
  /** 导入页据此在摘要里写出要用的 Java，有问题时展开设置。 */
  onResolvedChange?: (state: JavaResolvedState) => void;
}) {
  const { t } = useI18n();
  const selectId = useId();
  const [runtimes, setRuntimes] = useState<JavaRuntimeInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  // 至少成功读到过一次。之后刷新失败时沿用上次的结果，只在下方报错。
  const [loaded, setLoaded] = useState(false);
  const [defaultJava, setDefaultJava] = useState<JavaDetectResult | null>(null);
  const [installable, setInstallable] = useState<number[]>([]);
  const [installTask, setInstallTask] = useState<TaskInfo | null>(null);
  const [installError, setInstallError] = useState('');
  /** 点「安装 Java N」后先弹确认，确认了才开始下载。 */
  const [confirmOpen, setConfirmOpen] = useState(false);
  /** 已请求取消、等服务端停下下载；这期间「取消安装」显示「正在取消…」。 */
  const [cancelling, setCancelling] = useState(false);
  /** 用户在下拉框里亲手选过后，自动选择不再改动。 */
  const manualRef = useRef(false);
  /** 卸载时停止轮询安装任务；任务本身在服务端继续跑。 */
  const installAbortRef = useRef<AbortController | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  /** 加载代次：挂载加载与「重新扫描」并发时，丢弃先发起但后到达的旧响应。 */
  const loadGenerationRef = useRef(0);

  const load = useCallback(async (refresh: boolean) => {
    const generation = loadGenerationRef.current + 1;
    loadGenerationRef.current = generation;
    if (refresh) setRefreshing(true);
    try {
      const [result, detectedDefaultJava] = await Promise.all([
        listJavaRuntimes(refresh),
        detectDefaultJava(),
      ]);
      if (generation !== loadGenerationRef.current) return;
      setRuntimes(result.runtimes);
      setInstallable(result.installable);
      setDefaultJava(detectedDefaultJava);
      setLoaded(true);
      setError('');
    } catch (err) {
      if (generation !== loadGenerationRef.current) return;
      setError(errorMessage(err));
    } finally {
      if (generation === loadGenerationRef.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, []);

  useEffect(() => {
    void load(false);
  }, [load]);

  useEffect(() => () => installAbortRef.current?.abort(), []);

  const recommended = recommendedJavaMajor(mcVersion);
  const defaultMatches = Boolean(defaultJava?.available) && recommended != null && defaultJava?.majorVersion === recommended;
  const installedMatch =
    recommended == null ? null : runtimes.find((runtime) => runtime.available && runtime.majorVersion === recommended) ?? null;
  const hasRecommended = defaultMatches || installedMatch !== null;
  const canInstall = recommended != null && installable.includes(recommended) && !hasRecommended;
  const installing = installTask !== null;

  useEffect(() => {
    onInstallingChange?.(installing);
  }, [installing, onInstallingChange]);

  // 安装中被卸载（页面换了来源、收起了设置）时告诉页面不再安装，否则页面一直以为在装、提交按钮一直灰着。
  // 服务端的安装任务照常跑完，下次挂载会重新读到装好的 Java。
  const installingRef = useRef(installing);
  installingRef.current = installing;
  const onInstallingChangeRef = useRef(onInstallingChange);
  onInstallingChangeRef.current = onInstallingChange;
  useEffect(() => () => {
    if (installingRef.current) onInstallingChangeRef.current?.(false);
  }, []);

  // 自动选择：默认 Java 正好合适就用默认，否则选已装的同主版本 Java；都没有时回到默认。
  // 加载完成前不动，免得把用户的值先清空再选回来。
  useEffect(() => {
    if (!autoSelect || manualRef.current || loading || recommended == null) return;
    const wanted = defaultMatches ? null : installedMatch?.id ?? null;
    if (wanted !== value) onChangeRef.current(wanted);
  }, [autoSelect, defaultMatches, installedMatch?.id, loading, recommended, value]);

  const install = async (major: number) => {
    installAbortRef.current?.abort();
    const controller = new AbortController();
    installAbortRef.current = controller;
    setInstallError('');
    // 发出请求前就算「安装中」，按钮立刻变灰，页面也立刻暂停提交。
    setInstallTask({ id: '', type: 'download', status: 'pending', progress: 0, message: '', createdAt: '', updatedAt: '' });
    try {
      const task = await installJavaRuntime(major);
      if (controller.signal.aborted) return;
      setInstallTask(task);
      const result = await pollTask(task.id, setInstallTask, controller.signal);
      const listed = await listJavaRuntimes(false);
      if (controller.signal.aborted) return;
      setRuntimes(listed.runtimes);
      setInstallable(listed.installable);
      if (result?.javaRuntimeId) onChangeRef.current(result.javaRuntimeId);
    } catch (err) {
      if (controller.signal.aborted) return;
      // 自己取消的不算出错，按钮回到「安装 Java N」就够了。
      if (serverErrorKey(err) !== 'server.tasks.cancelledByUser') setInstallError(errorMessage(err));
    } finally {
      if (installAbortRef.current === controller) {
        installAbortRef.current = null;
        setInstallTask(null);
        setCancelling(false);
      }
    }
  };

  /** 取消正在进行的安装：服务端停下下载、清掉临时文件后任务才结束，轮询会接着收到结果。 */
  const cancelInstall = async (taskId: string) => {
    setCancelling(true);
    try {
      await cancelJavaInstall(taskId);
    } catch (err) {
      // 刚好装完或失败了：轮询会拿到真正的结果，不用再报一次错。
      if (serverErrorKey(err) === 'server.jvm.javaInstall.notCancellable') return;
      setCancelling(false);
      setInstallError(errorMessage(err));
    }
  };
  const selected = value ? runtimes.find((runtime) => runtime.id === value) ?? null : null;
  // 选中的 Java 不在列表里（还没读完、没读到、或已从注册表里消失）：下拉框里没有对应选项时，
  // 浏览器会显示第一项「系统默认」，看起来像是用默认 Java，所以单独补一个选项把它显示出来。
  const selectedMissing = Boolean(value) && selected === null;
  const resolvedMajor = value ? selected?.majorVersion ?? null : defaultJava?.majorVersion ?? null;
  const resolvedAvailable = value ? Boolean(selected?.available) : Boolean(defaultJava?.available);
  const mismatch =
    resolvedAvailable && resolvedMajor != null && recommended != null && resolvedMajor !== recommended;
  // 第一次读取就失败：什么都不知道，下面的「没检测到」「已不可用」都不能说。
  const unknown = !loading && !loaded;
  // 没装 Java、选中的已不可用、主版本不是推荐版本，都算不符。
  const matchStatus: JavaMatchStatus = recommended == null
    ? 'match'
    : loading
      ? 'loading'
      : unknown
        ? 'unknown'
        : resolvedAvailable && resolvedMajor === recommended ? 'match' : 'mismatch';

  useEffect(() => {
    onMatchStatusChange?.(matchStatus);
  }, [matchStatus, onMatchStatusChange]);

  useEffect(() => {
    onResolvedMajorChange?.(value ? selected?.majorVersion ?? null : defaultJava?.majorVersion ?? null);
  }, [defaultJava?.majorVersion, onResolvedMajorChange, selected?.majorVersion, value]);

  const availability: JavaResolvedState['availability'] = loading ? 'loading'
    : unknown ? 'unknown'
      : resolvedAvailable ? 'ready' : 'missing';
  useEffect(() => {
    onResolvedChange?.({ availability, major: resolvedMajor, systemDefault: !value, matchStatus, recommended });
  }, [availability, matchStatus, onResolvedChange, recommended, resolvedMajor, value]);

  // 选项只写主版本，同一个主版本装了不止一个时才带上路径区分；选中的那个的路径放在下拉框的悬停提示里。
  const versionLabel = (runtime: JavaRuntimeInfo) => String(runtime.majorVersion ?? runtime.version ?? t('java.runtime.unknownVersion'));
  const labelCounts = new Map<string, number>();
  for (const runtime of runtimes) labelCounts.set(versionLabel(runtime), (labelCounts.get(versionLabel(runtime)) ?? 0) + 1);
  const optionLabel = (runtime: JavaRuntimeInfo) => {
    const params = { version: versionLabel(runtime), path: runtime.path };
    if ((labelCounts.get(params.version) ?? 0) > 1) {
      return t(runtime.available ? 'java.runtime.option' : 'java.runtime.optionUnavailable', params);
    }
    return t(runtime.available ? 'java.runtime.optionShort' : 'java.runtime.optionShortUnavailable', params);
  };

  // 推荐版本跟在状态点后面：实际要用的 Java 不是它（含没装 Java，这时没有橙色警告）或列表没读到时才写，对得上就不占位置。
  const showRecommended = recommended != null && (matchStatus === 'mismatch' || matchStatus === 'unknown');
  const showInstall = canInstall && !loading;
  const showStatus = !unknown && (!value || loading || Boolean(selected?.available));

  return (
    <div className="field">
      <label htmlFor={selectId}>{t('java.runtime.label')}</label>
      <div className="input-row">
        <select
          id={selectId}
          value={value ?? ''}
          title={selected?.path}
          disabled={disabled || loading || installing}
          onChange={(e) => {
            manualRef.current = true;
            onChange(e.target.value || null);
          }}
        >
          <option value="">{t('java.runtime.systemDefault')}</option>
          {/* 只有列表读到了、里面确实没有，才说「已不可用」并禁止再选回来；没读到时不下结论。 */}
          {selectedMissing && (
            <option value={value!} disabled={!loading && !unknown}>
              {loading ? t('common.loading') : unknown ? t('java.runtime.optionUnloaded') : t('java.runtime.optionMissing')}
            </option>
          )}
          {runtimes.map((runtime) => (
            <option key={runtime.id} value={runtime.id} disabled={!runtime.available}>
              {optionLabel(runtime)}
            </option>
          ))}
        </select>
        <button
          className="btn"
          type="button"
          disabled={disabled || refreshing || installing}
          title={t('java.runtime.rescan.title')}
          onClick={() => void load(true)}
        >
          <RefreshCw size={14} aria-hidden="true" className={refreshing ? 'spin' : undefined} />
          {refreshing ? t('java.runtime.rescanning') : t('java.runtime.rescan')}
        </button>
      </div>
      {/*
        状态点、推荐版本、「安装 Java N」和手动下载排成一行，放不下时自动换行。
        状态点说的是实际要用的那个 Java：选了面板登记的 Java 就说它，没选才说系统默认 Java。
        选中的已不可用时不放状态点，下方的橙色提示已经说了。
      */}
      {(showStatus || showRecommended || showInstall) && (
        <div className="java-status-row">
          {showStatus && (value ? (
            <div className={`environment-status${loading ? '' : ' is-ready'}`}>
              <span className="status-dot" aria-hidden="true" />
              {loading
                ? t('java.selected.checking')
                : t('java.selected.available', { version: selected?.version ?? versionLabel(selected!) })}
            </div>
          ) : (
            <div className={`environment-status${loading && defaultJava === null ? '' : defaultJava?.available ? ' is-ready' : ' is-missing'}`}>
              <span className="status-dot" aria-hidden="true" />
              {loading && defaultJava === null
                ? t('java.default.checking')
                : defaultJava?.available
                  ? defaultJava.version
                    ? t('java.default.availableWithVersion', { version: defaultJava.version })
                    : t('java.default.available')
                  : t('java.default.missing')}
            </div>
          ))}
          {showRecommended && <span className="java-recommended">{t('java.runtime.recommended', { java: recommended })}</span>}
          {showInstall && (
            <>
              {/* 先弹确认（写明下载来源和大小），确认后才开始下载。 */}
              <button
                className="btn btn-primary btn-sm"
                type="button"
                disabled={disabled || installing}
                onClick={() => setConfirmOpen(true)}
              >
                <Download size={14} aria-hidden="true" />
                {installing ? t('java.install.running', { java: recommended }) : t('java.install.button', { java: recommended })}
              </button>
              <a href={javaDownloadUrl(recommended)} target="_blank" rel="noreferrer" className="link">
                {t('java.install.manual')}
              </a>
            </>
          )}
        </div>
      )}
      {showInstall && installTask && (
        <TaskProgress
          task={installTask}
          label={t('java.install.progress', { java: recommended })}
          action={(
            // 请求还没拿到任务 ID 时没法取消，先灰着。
            <button
              className="btn btn-sm btn-plain"
              type="button"
              disabled={!installTask.id || cancelling}
              onClick={() => void cancelInstall(installTask.id)}
            >
              {cancelling ? t('java.install.cancelling') : t('java.install.cancel')}
            </button>
          )}
        />
      )}
      {showInstall && installError && <p className="error" role="alert">{installError}</p>}
      {recommended != null && (
        <ConfirmDialog
          open={confirmOpen}
          title={t('java.install.confirm.title', { java: recommended })}
          description={<p>{t('java.install.confirm.body', { java: recommended })}</p>}
          confirmLabel={t('java.install.button', { java: recommended })}
          onConfirm={() => {
            setConfirmOpen(false);
            void install(recommended);
          }}
          onCancel={() => setConfirmOpen(false)}
        />
      )}
      {mismatch && (
        <p className="field-warn" role="alert">
          {t(value ? 'java.warn.mismatch.selected' : 'java.warn.mismatch.default', {
            actual: resolvedMajor,
            recommended,
          })}
          {/* 推荐版本已经装了时只需改选，不再引去下载；能一键安装时由下方按钮代替 */}
          {!canInstall && !hasRecommended && (
            <>
              {' '}
              <a href={javaDownloadUrl(recommended)} target="_blank" rel="noreferrer" className="link">
                {t('java.download.version', { java: recommended })}
              </a>
            </>
          )}
        </p>
      )}
      {!value && !loading && defaultJava !== null && !defaultJava.available && !canInstall && (
        <p className="field-warn">
          <a href={javaDownloadUrl(recommended)} target="_blank" rel="noreferrer" className="link">
            {recommended != null ? t('java.download.version', { java: recommended }) : t('java.download.any')}
          </a>
        </p>
      )}
      {value && !loading && !unknown && (!selected || !selected.available) && (
        <p className="field-warn" role="alert">
          {t('java.warn.unavailable')}
        </p>
      )}
      {error && <p className="error" role="alert">{t(unknown ? 'java.error.loadRetry' : 'java.error.load', { error })}</p>}
    </div>
  );
}
