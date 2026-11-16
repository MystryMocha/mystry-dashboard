import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { recommendedJavaMajor, type JavaDetectResult, type JavaRuntimeInfo } from '@mystry/shared';
import { detectDefaultJava, listJavaRuntimes } from '../api';
import { errorMessage } from '../errors';
import { useI18n } from '../i18n';
import { javaDownloadUrl } from '../java-download';

/**
 * Java 运行时选择器：
 * - 选项只来自面板探测并已验证的注册表，外加「默认（PATH 中的 java）」。
 * - 传入 mcVersion 时显示推荐版本，所选运行时不匹配给出告警。
 */
export function JavaRuntimeSelect({
  value,
  onChange,
  mcVersion,
  disabled = false,
  onResolvedMajorChange,
}: {
  value: string | null;
  onChange: (runtimeId: string | null) => void;
  mcVersion?: string | null;
  disabled?: boolean;
  onResolvedMajorChange?: (major: number | null) => void;
}) {
  const { t } = useI18n();
  const selectId = useId();
  const [runtimes, setRuntimes] = useState<JavaRuntimeInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [defaultJava, setDefaultJava] = useState<JavaDetectResult | null>(null);
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
      setRuntimes(result);
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

  const recommended = recommendedJavaMajor(mcVersion);
  const selected = value ? runtimes.find((runtime) => runtime.id === value) ?? null : null;
  const resolvedMajor = value ? selected?.majorVersion ?? null : defaultJava?.majorVersion ?? null;
  const resolvedAvailable = value ? Boolean(selected?.available) : Boolean(defaultJava?.available);
  const mismatch =
    resolvedAvailable && resolvedMajor != null && recommended != null && resolvedMajor !== recommended;

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
          disabled={disabled || loading}
          onChange={(e) => onChange(e.target.value || null)}
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
          disabled={disabled || refreshing}
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
          {' '}
          <a href={javaDownloadUrl(recommended)} target="_blank" rel="noreferrer" className="link">
            {t('java.download.version', { java: recommended })}
          </a>
        </p>
      )}
      {!value && !loading && defaultJava !== null && !defaultJava.available && (
        <p className="field-warn">
          <a href={javaDownloadUrl(recommended)} target="_blank" rel="noreferrer" className="link">
            {recommended != null ? t('java.download.version', { java: recommended }) : t('java.download.any')}
          </a>
        </p>
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
