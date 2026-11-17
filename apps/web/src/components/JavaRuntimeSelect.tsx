import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Download, RefreshCw } from 'lucide-react';
import { recommendedJavaMajor, type JavaDetectResult, type JavaRuntimeInfo, type TaskInfo } from '@mystry/shared';
import { detectDefaultJava, installJavaRuntime, listJavaRuntimes, pollTask } from '../api';
import { errorMessage } from '../errors';
import { useI18n } from '../i18n';
import { javaDownloadUrl } from '../java-download';
import { TaskProgress } from './TaskProgress';

/**
 * Java 运行时选择器：
 * - 选项只来自面板探测并已验证的注册表，外加「默认（PATH 中的 java）」。
 * - 传入 mcVersion 时显示推荐版本，所选运行时不匹配给出告警。
 * - autoSelect（只给新建实例用）：用户没手动选过时，自动选中与推荐主版本相同的已装 Java。
 *   实例设置页不开，避免打开页面就悄悄改掉已有实例的 Java。
 * - 推荐版本没装、面板能装时给出「安装 Java N」按钮，装好后选中它。
 */
/** 实际要用的 Java 是否就是推荐版本：loading 还没读完；版本未知（不推荐）时算 match。 */
export type JavaMatchStatus = 'loading' | 'match' | 'mismatch';

export function JavaRuntimeSelect({
  value,
  onChange,
  mcVersion,
  disabled = false,
  onResolvedMajorChange,
  autoSelect = false,
  onInstallingChange,
  onMatchStatusChange,
}: {
  value: string | null;
  onChange: (runtimeId: string | null) => void;
  mcVersion?: string | null;
  disabled?: boolean;
  onResolvedMajorChange?: (major: number | null) => void;
  autoSelect?: boolean;
  /** 一键安装进行中时为 true；页面据此暂停提交，免得用错的 Java 建实例。 */
  onInstallingChange?: (installing: boolean) => void;
  /** 部署页据此在版本不符时禁止开始部署。 */
  onMatchStatusChange?: (status: JavaMatchStatus) => void;
}) {
  const { t } = useI18n();
  const selectId = useId();
  const [runtimes, setRuntimes] = useState<JavaRuntimeInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [defaultJava, setDefaultJava] = useState<JavaDetectResult | null>(null);
  const [installable, setInstallable] = useState<number[]>([]);
  const [installTask, setInstallTask] = useState<TaskInfo | null>(null);
  const [installError, setInstallError] = useState('');
  /** 用户在下拉框里亲手选过后，自动选择不再改动。 */
  const manualRef = useRef(false);
  /** 卸载时停止轮询安装任务；任务本身在服务端继续跑。 */
  const installAbortRef = useRef<AbortController | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  /** 加载代次：挂载加载与「重新探测」并发时，丢弃先发起但后到达的旧响应。 */
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
      setInstallError(errorMessage(err));
    } finally {
      if (installAbortRef.current === controller) {
        installAbortRef.current = null;
        setInstallTask(null);
      }
    }
  };
  const selected = value ? runtimes.find((runtime) => runtime.id === value) ?? null : null;
  const resolvedMajor = value ? selected?.majorVersion ?? null : defaultJava?.majorVersion ?? null;
  const resolvedAvailable = value ? Boolean(selected?.available) : Boolean(defaultJava?.available);
  const mismatch =
    resolvedAvailable && resolvedMajor != null && recommended != null && resolvedMajor !== recommended;
  // 没装 Java、选中的已不可用、主版本不是推荐版本，都算不符。
  const matchStatus: JavaMatchStatus = recommended == null
    ? 'match'
    : loading
      ? 'loading'
      : resolvedAvailable && resolvedMajor === recommended ? 'match' : 'mismatch';

  useEffect(() => {
    onMatchStatusChange?.(matchStatus);
  }, [matchStatus, onMatchStatusChange]);

  useEffect(() => {
    onResolvedMajorChange?.(value ? selected?.majorVersion ?? null : defaultJava?.majorVersion ?? null);
  }, [defaultJava?.majorVersion, onResolvedMajorChange, selected?.majorVersion, value]);

  return (
    <div className="field">
      <label htmlFor={selectId}>{t('java.runtime.label')}</label>
      <div className="input-row">
        <select
          id={selectId}
          value={value ?? ''}
          disabled={disabled || loading || installing}
          onChange={(e) => {
            manualRef.current = true;
            onChange(e.target.value || null);
          }}
        >
          <option value="">{t('java.runtime.systemDefault')}</option>
          {runtimes.map((runtime) => (
            <option key={runtime.id} value={runtime.id} disabled={!runtime.available}>
              {t(runtime.available ? 'java.runtime.option' : 'java.runtime.optionUnavailable', {
                version: runtime.majorVersion ?? runtime.version ?? t('java.runtime.unknownVersion'),
                path: runtime.path,
              })}
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
      <p className="field-help">{t('java.help.default')}</p>
      {recommended != null && (
        <p className="field-help">{t('java.help.recommended', { mcVersion: mcVersion ?? '', java: recommended })}</p>
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
      {canInstall && !loading && (
        <div className="java-install">
          <p className="field-help">{t('java.install.hint', { java: recommended })}</p>
          <div className="java-install-actions">
            <button
              className="btn btn-primary"
              type="button"
              disabled={disabled || installing}
              onClick={() => void install(recommended)}
            >
              <Download size={14} aria-hidden="true" />
              {installing ? t('java.install.running', { java: recommended }) : t('java.install.button', { java: recommended })}
            </button>
            <a href={javaDownloadUrl(recommended)} target="_blank" rel="noreferrer" className="link">
              {t('java.install.manual')}
            </a>
          </div>
          {installTask && <TaskProgress task={installTask} label={t('java.install.progress', { java: recommended })} />}
          {installError && <p className="error" role="alert">{installError}</p>}
        </div>
      )}
      {value && !loading && (!selected || !selected.available) && (
        <p className="field-warn" role="alert">
          {t('java.warn.unavailable')}
        </p>
      )}
      {error && <p className="error">{t('java.error.load', { error })}</p>}
    </div>
  );
}
