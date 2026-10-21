import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { recommendedJavaMajor, type JavaDetectResult, type JavaRuntimeInfo } from '@mystry/shared';
import { detectDefaultJava, listJavaRuntimes } from '../api';

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
      setError(err instanceof Error ? err.message : String(err));
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
      <label htmlFor={selectId}>Java 运行时</label>
      <div className={`environment-status ${defaultJava?.available === false ? 'is-missing' : ''}`}>
        <span className="environment-dot" />
        {loading && defaultJava === null
          ? '正在检查系统默认 Java…'
          : defaultJava?.available
            ? `系统默认 Java 可用${defaultJava.version ? ` · ${defaultJava.version}` : ''}`
            : '未找到系统默认 Java，请先安装 Java 后点「重新探测」'}
      </div>
      <p className="muted field-help">默认使用系统 Java；电脑上装了多个 Java 时，可以在下面选择要用的版本。</p>
      <div className="btn-row" style={{ alignItems: 'stretch' }}>
        <select
          id={selectId}
          style={{ flex: 1, minWidth: 0 }}
          value={value ?? ''}
          disabled={disabled || loading}
          onChange={(e) => onChange(e.target.value || null)}
        >
          <option value="">系统默认 Java</option>
          {runtimes.map((runtime) => (
            <option key={runtime.id} value={runtime.id} disabled={!runtime.available}>
              {`Java ${runtime.majorVersion ?? runtime.version ?? '未知版本'} · ${runtime.path}${runtime.available ? '' : '（不可用）'}`}
            </option>
          ))}
        </select>
        <button
          className="btn btn-ghost"
          type="button"
          disabled={disabled || refreshing}
          title="重新扫描本机 Java 安装目录"
          onClick={() => void load(true)}
        >
          {refreshing ? '探测中…' : '重新探测'}
        </button>
      </div>
      {recommended != null && (
        <p className="muted field-help">当前 Minecraft {mcVersion} 推荐使用 Java {recommended}。</p>
      )}
      {mismatch && (
        <p className="field-warn" role="alert">
          {value ? '所选 Java' : '系统默认 Java'} 是 Java {resolvedMajor}，推荐使用 Java {recommended}；版本不符时服务器可能无法启动。
        </p>
      )}
      {value && !loading && (!selected || !selected.available) && (
        <p className="field-warn" role="alert">
          之前选择的 Java 已不可用，保存前请点「重新探测」并重新选择。
        </p>
      )}
      {error && <p className="error">无法读取本机 Java 列表：{error}</p>}
    </div>
  );
}
