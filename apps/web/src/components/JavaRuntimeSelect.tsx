import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Download, RefreshCw } from 'lucide-react';
import { recommendedJavaMajor, type JavaDetectResult, type JavaRuntimeInfo, type PanelMessage, type TaskInfo } from '@mystry/shared';
import { cancelJavaInstall, detectDefaultJava, installJavaRuntime, listJavaRuntimes, pollTask } from '../api';
import { errorMessage } from '../errors';
import { useI18n } from '../i18n';
import { javaDownloadUrl } from '../java-download';
import { ConfirmDialog } from './ConfirmDialog';
import { TaskProgress } from './TaskProgress';

/** The server message key carried by an API error or a task failure thrown by pollTask. */
function serverErrorKey(error: unknown): string | undefined {
  return (error as { messageI18n?: PanelMessage } | null)?.messageI18n?.key;
}

/**
 * Java runtime picker:
 * - Options come only from the registry the panel detected and verified, plus "Default (java on PATH)".
 * - When mcVersion is passed the recommended version is shown, and a warning is given when the chosen runtime does not match.
 * - autoSelect (for new instances only): when the user has not chosen manually, an installed Java with the recommended major version is selected automatically.
 *   It is off on the instance settings page, so opening the page does not silently change an existing instance's Java.
 * - When the recommended version is not installed and the panel can install it, an "Install Java N" button is offered, and it is selected once installed.
 */
/** Whether the Java that will actually be used is the recommended version: loading means not read yet; an unknown version (no recommendation) counts as match. */
/** unknown: the Java list has never been read, so whether one is installed and which version is unknown, and it cannot be called a "version mismatch". */
export type JavaMatchStatus = 'loading' | 'match' | 'mismatch' | 'unknown';

/**
 * How the Java that will actually be used is doing right now, for the page's summary.
 * loading: not read yet; unknown: the list has never been read; ready: usable; missing: no Java installed, or the chosen one is no longer available.
 * matchStatus is always match when the Minecraft version is unknown and cannot tell "still reading" from "no Java", hence this separate value.
 */
export type JavaResolvedState = {
  availability: 'loading' | 'unknown' | 'ready' | 'missing';
  major: number | null;
  /** The system default Java (java on PATH) is used, not one registered with the panel. */
  systemDefault: boolean;
  matchStatus: JavaMatchStatus;
  /** The major version recommended for the current Minecraft version; null when the version is unknown. */
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
  /** true while a one-click install is in progress; the page pauses submission based on it, so an instance is not created with the wrong Java. */
  onInstallingChange?: (installing: boolean) => void;
  /** The deploy page uses this to forbid starting a deployment on a version mismatch. */
  onMatchStatusChange?: (status: JavaMatchStatus) => void;
  /** The import page uses this to write the Java to be used in the summary, and to expand the settings when there is a problem. */
  onResolvedChange?: (state: JavaResolvedState) => void;
}) {
  const { t } = useI18n();
  const selectId = useId();
  const [runtimes, setRuntimes] = useState<JavaRuntimeInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  // Read successfully at least once. When a later refresh fails the previous result is kept, with only an error shown below.
  const [loaded, setLoaded] = useState(false);
  const [defaultJava, setDefaultJava] = useState<JavaDetectResult | null>(null);
  const [installable, setInstallable] = useState<number[]>([]);
  const [installTask, setInstallTask] = useState<TaskInfo | null>(null);
  const [installError, setInstallError] = useState('');
  /** Clicking "Install Java N" shows a confirmation first, and the download starts only after confirming. */
  const [confirmOpen, setConfirmOpen] = useState(false);
  /** Cancel was requested and the server has yet to stop the download; meanwhile "Cancel install" shows "Cancelling…". */
  const [cancelling, setCancelling] = useState(false);
  /** Once the user has picked in the dropdown by hand, auto-selection makes no more changes. */
  const manualRef = useRef(false);
  /** Stops polling the install task on unmount; the task itself keeps running on the server. */
  const installAbortRef = useRef<AbortController | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  /** Load generation: when the mount load and "Rescan" run concurrently, an old response that was sent first but arrived later is discarded. */
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

  // When unmounted mid-install (the page changed the source or collapsed the settings), the page is told installing has stopped, or it would think it is still installing forever and the submit button would stay grey.
  // The server's install task runs to completion as usual, and the next mount reads the installed Java again.
  const installingRef = useRef(installing);
  installingRef.current = installing;
  const onInstallingChangeRef = useRef(onInstallingChange);
  onInstallingChangeRef.current = onInstallingChange;
  useEffect(() => () => {
    if (installingRef.current) onInstallingChangeRef.current?.(false);
  }, []);

  // Auto-selection: use the default when the default Java fits exactly, otherwise select an installed Java with the same major version; fall back to the default when there is neither.
  // Nothing is touched before loading completes, so the user's value is not cleared first and then selected back.
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
    // It counts as "installing" before the request is even sent, so the button greys out at once and the page pauses submission at once.
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
      // A cancel by the user is not an error; the button returning to "Install Java N" is enough.
      if (serverErrorKey(err) !== 'server.tasks.cancelledByUser') setInstallError(errorMessage(err));
    } finally {
      if (installAbortRef.current === controller) {
        installAbortRef.current = null;
        setInstallTask(null);
        setCancelling(false);
      }
    }
  };

  /** Cancels the install in progress: the task ends only after the server stops the download and cleans up temp files, and polling then receives the result. */
  const cancelInstall = async (taskId: string) => {
    setCancelling(true);
    try {
      await cancelJavaInstall(taskId);
    } catch (err) {
      // It happened to finish or fail just then: polling gets the real result, so no second error is reported.
      if (serverErrorKey(err) === 'server.jvm.javaInstall.notCancellable') return;
      setCancelling(false);
      setInstallError(errorMessage(err));
    }
  };
  const selected = value ? runtimes.find((runtime) => runtime.id === value) ?? null : null;
  // The selected Java is not in the list (not read yet, failed to read, or gone from the registry): with no matching option in the dropdown,
  // the browser would display the first item "System default", looking as if the default Java were used, so a separate option is added to display it.
  const selectedMissing = Boolean(value) && selected === null;
  const resolvedMajor = value ? selected?.majorVersion ?? null : defaultJava?.majorVersion ?? null;
  const resolvedAvailable = value ? Boolean(selected?.available) : Boolean(defaultJava?.available);
  const mismatch =
    resolvedAvailable && resolvedMajor != null && recommended != null && resolvedMajor !== recommended;
  // The very first read failed: nothing is known, and neither "not detected" nor "no longer available" below can be said.
  const unknown = !loading && !loaded;
  // No Java installed, the selected one no longer available, and a major version that is not the recommended one all count as a mismatch.
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

  // Options state only the major version, with the path added to tell them apart only when more than one of the same major version is installed; the selected one's path is in the dropdown's hover tooltip.
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

  // The recommended version follows the status dot: it is written only when the Java that will actually be used is not it (including no Java installed, where there is no orange warning) or the list was not read, and takes no space when they match.
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
          {/* Only when the list was read and it really is not in it does this say "no longer available" and forbid selecting it back; no conclusion is drawn when the list was not read. */}
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
        The status dot, the recommended version, "Install Java N" and manual download sit on one row, wrapping automatically when they do not fit.
        The status dot describes the Java that will actually be used: a Java registered with the panel when one is selected, the system default Java only when none is.
        No status dot when the selected one is no longer available; the orange notice below already says so.
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
              {/* Show a confirmation first (stating the download source and size), and start the download only after confirming. */}
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
            // It cannot be cancelled before the request has a task ID, so it stays grey for now.
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
          {/* When the recommended version is already installed, only a different choice is needed and no download is suggested; when one-click install is possible the button below takes its place */}
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
