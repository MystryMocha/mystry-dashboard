import { useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  JVM_PRESETS,
  automaticInitialMemoryMiB,
  buildJvmArgs,
  inspectJvmArgs,
  parseJvmArgs,
  recommendedMaxMemoryMiB,
  validateJvmArgs,
  type CoreType,
  type DetectedJvmConfig,
  type JvmPresetId,
  type JvmValidationIssue,
} from '@mystry/shared';
import { listNodes } from '../api';
import { useI18n, type I18n, type MessageKey } from '../i18n';
import { useFieldFeedback } from './Field';
import { NumberInput } from './NumberInput';

export type DetectedJvmChoice = 'detected' | 'recommended' | 'custom' | null;

type BuiltinPresetId = Exclude<JvmPresetId, 'custom'>;

const PRESET_LABEL_KEYS: Record<BuiltinPresetId, MessageKey> = {
  compatibility: 'jvm.preset.compatibility.label',
  'g1-balanced': 'jvm.preset.g1-balanced.label',
  'paper-aikar': 'jvm.preset.paper-aikar.label',
};

const PRESET_DESCRIPTION_KEYS: Record<BuiltinPresetId, MessageKey> = {
  compatibility: 'jvm.preset.compatibility.description',
  'g1-balanced': 'jvm.preset.g1-balanced.description',
  'paper-aikar': 'jvm.preset.paper-aikar.description',
};

/**
 * 把共享包 JVM 诊断翻译为当前语言：诊断带消息键与参数（`server.jvm.issue.*`）时按键翻译，
 * 预设名称等嵌套参数一并翻译；没有键的诊断（其他来源的检测错误或旧数据）回落显示原文。
 */
function translateJvmIssue(item: JvmValidationIssue, tm: I18n['tm']): string {
  return tm(item.key ? { key: item.key, params: item.params } : undefined, item.message);
}

type Draft = {
  xmsMiB: number;
  xmxMiB: number;
  presetId: JvmPresetId;
  extraArgs: string;
  manualXms: boolean;
  rawMode: boolean;
};

function draftFromValue(value: string): Draft {
  const parsed = inspectJvmArgs(value);
  if (parsed.xmsMiB === null || parsed.xmxMiB === null) {
    return {
      xmsMiB: 1024,
      xmxMiB: 2048,
      presetId: 'custom',
      extraArgs: value,
      manualXms: true,
      rawMode: true,
    };
  }
  const automaticXms = automaticInitialMemoryMiB(parsed.presetId, parsed.xmxMiB);
  return {
    xmsMiB: parsed.xmsMiB,
    xmxMiB: parsed.xmxMiB,
    presetId: parsed.presetId,
    extraArgs: parsed.extraArgs,
    manualXms: parsed.xmsMiB !== automaticXms,
    rawMode: false,
  };
}

/** 用户亲手填的内存不能低于这个数（原来输入框的 min=512）；没动过的旧值不受它限制。 */
const MIN_MEMORY_MIB = 512;
/** 常用档位（GB）。推荐值不在其中时会另外插进去。 */
const MEMORY_TIERS_GB = [1, 2, 4, 6, 8, 12, 16, 24, 32];

/**
 * MiB 换成输入框里显示的 GB 文本：整数 GB 显示整数，其余最多两位小数（2500M 显示 2.44）。
 * 这里只用半角数字和小数点，因为输入框的内容还要被解析回去；给人看的档位和说明才走 fmt。
 */
function gbText(mib: number): string {
  return String(Math.round((mib / 1024) * 100) / 100);
}

type MemoryTextError = 'empty' | 'invalid' | 'min';

/**
 * 把用户填的 GB 文本换成 MiB。`keepMiB` 是外面传进来的原值：填回和它显示相同的数时直接用原值，
 * 免得 2.44 × 1024 取整成 2499，把 2500M 改写掉。
 */
function parseMemoryText(text: string, keepMiB: number | null): { mib: number } | { error: MemoryTextError } {
  if (text === '') return { error: 'empty' };
  const gb = Number(text);
  if (!/^\d*\.?\d*$/.test(text) || !Number.isFinite(gb)) return { error: 'invalid' };
  if (keepMiB !== null && gb === Number(gbText(keepMiB))) return { mib: keepMiB };
  const mib = Math.round(gb * 1024);
  if (!Number.isSafeInteger(mib)) return { error: 'invalid' };
  if (mib < MIN_MEMORY_MIB) return { error: 'min' };
  return { mib };
}

const MEMORY_ERROR_KEYS: Record<MemoryTextError, MessageKey> = {
  empty: 'jvm.memory.error.empty',
  invalid: 'jvm.memory.error.invalid',
  min: 'jvm.memory.error.min',
};

function buildDraftValue(draft: Draft): string {
  if (draft.rawMode) return draft.extraArgs;
  try {
    return buildJvmArgs(draft);
  } catch {
    const preset = JVM_PRESETS.find((item) => item.id === draft.presetId);
    return [
      `-Xms${Math.round(draft.xmsMiB)}M`,
      `-Xmx${Math.round(draft.xmxMiB)}M`,
      ...(preset?.args ?? []),
      draft.extraArgs,
    ].filter(Boolean).join(' ');
  }
}

export function JvmSettingsEditor({
  value,
  onChange,
  coreType,
  javaMajor,
  disabled = false,
  useRecommendedDefault = false,
  detectedJvmConfig,
  detectedChoice = null,
  onDetectedChoiceChange,
  onValidityChange,
}: {
  value: string;
  onChange: (value: string) => void;
  coreType: CoreType;
  javaMajor: number | null;
  disabled?: boolean;
  useRecommendedDefault?: boolean;
  detectedJvmConfig?: DetectedJvmConfig;
  detectedChoice?: DetectedJvmChoice;
  onDetectedChoiceChange?: (choice: DetectedJvmChoice) => void;
  onValidityChange?: (valid: boolean) => void;
}) {
  const { t, tm, rich, fmt } = useI18n();
  const maximumId = useId();
  const presetId = useId();
  const xmsId = useId();
  const extraId = useId();
  const [draft, setDraft] = useState<Draft>(() => draftFromValue(value));
  // 两个内存框里用户正在填的文本；null 表示没在编辑，按 draft 里的数显示。
  // 数值只在用户改这个框时才从文本算出来，其余操作一律用 draft 里的 MiB，所以 2500M 不会被四舍五入改写。
  const [xmxText, setXmxText] = useState<string | null>(null);
  const [xmsText, setXmsText] = useState<string | null>(null);
  // 外面传进来的原值，见 parseMemoryText。
  const loadedRef = useRef({ xmxMiB: draft.rawMode ? null : draft.xmxMiB, xmsMiB: draft.rawMode ? null : draft.xmsMiB });
  // 「高级 JVM 参数」折叠区（「最终参数」也在里面）：挂载时或外部换入的参数里有手动初始内存、额外参数就展开；
  // 参数第一次出现错误时也单向展开一次。不做成完全受控，用户填了自定义参数后仍能收起。
  const [advancedOpen, setAdvancedOpen] = useState(() => draft.manualXms || draft.extraArgs.trim() !== '');
  const [totalMemoryMiB, setTotalMemoryMiB] = useState<number | null>(null);
  const touchedRef = useRef(false);
  const recommendedAppliedRef = useRef(false);
  const lastEmittedRef = useRef<string | null>(null);

  useEffect(() => {
    let active = true;
    void listNodes()
      .then((nodes) => {
        if (!active) return;
        setTotalMemoryMiB(nodes.find((node) => node.isLocal)?.hostInfo?.totalMemMb ?? null);
      })
      .catch(() => {
        if (active) setTotalMemoryMiB(null);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (value === lastEmittedRef.current) {
      lastEmittedRef.current = null;
      return;
    }
    const next = draftFromValue(value);
    loadDraft(next);
    revealCustomParts(next);
  }, [value]);

  /** 换成一份不是用户在内存框里打出来的配置：丢掉两个框里没填完的文本。 */
  function loadDraft(next: Draft) {
    setDraft(next);
    setXmxText(null);
    setXmsText(null);
    loadedRef.current = { xmxMiB: next.rawMode ? null : next.xmxMiB, xmsMiB: next.rawMode ? null : next.xmsMiB };
  }

  /**
   * 整份换入的配置（外部传入、沿用或以检测结果为底自定义）带自定义部分时展开高级区，
   * 免得附加参数、手动初始内存藏在折叠区里就被提交。
   */
  function revealCustomParts(next: Draft) {
    if (next.manualXms || next.extraArgs.trim() !== '') setAdvancedOpen(true);
  }

  const recommendedMaximum = recommendedMaxMemoryMiB(totalMemoryMiB);

  useEffect(() => {
    if (
      !useRecommendedDefault
      || recommendedAppliedRef.current
      || touchedRef.current
      || totalMemoryMiB === null
    ) return;
    const parsed = inspectJvmArgs(value);
    if (
      parsed.xmsMiB !== 1024
      || parsed.xmxMiB !== 2048
      || parsed.presetId !== 'compatibility'
      || parsed.extraArgs
    ) return;
    recommendedAppliedRef.current = true;
    const next: Draft = {
      ...draft,
      xmxMiB: recommendedMaximum,
      xmsMiB: automaticInitialMemoryMiB(draft.presetId, recommendedMaximum),
    };
    const nextValue = buildDraftValue(next);
    loadDraft(next);
    lastEmittedRef.current = nextValue;
    onChange(nextValue);
  }, [draft, onChange, recommendedMaximum, totalMemoryMiB, useRecommendedDefault, value]);

  const issues = useMemo(
    () => validateJvmArgs(value, { coreType, javaMajor, totalMemoryMiB }),
    [coreType, javaMajor, totalMemoryMiB, value],
  );
  const selectedPreset = JVM_PRESETS.find((item) => item.id === draft.presetId) ?? null;
  const needsDetectedChoice = Boolean(detectedJvmConfig && detectedChoice === null);

  // 内存框的文本不合法时不外发，value 还是上一个合法值；这里把它并进 valid，上层据此拦住保存。
  const xmxParsed = xmxText === null ? null : parseMemoryText(xmxText, loadedRef.current.xmxMiB);
  const xmsParsed = xmsText === null || !draft.manualXms ? null : parseMemoryText(xmsText, loadedRef.current.xmsMiB);
  const memoryErrorText = (parsed: typeof xmxParsed): string | null => (
    !draft.rawMode && parsed && 'error' in parsed
      ? t(MEMORY_ERROR_KEYS[parsed.error], { min: fmt.number(MIN_MEMORY_MIB / 1024) })
      : null
  );
  const xmxError = memoryErrorText(xmxParsed);
  const xmsError = memoryErrorText(xmsParsed);
  const xmxFeedback = useFieldFeedback(xmxError);
  const xmsFeedback = useFieldFeedback(xmsError);

  const hasError = issues.some((item) => item.severity === 'error');
  const valid = !needsDetectedChoice && !hasError && !xmxError && !xmsError;

  const openedForErrorRef = useRef(false);
  useEffect(() => {
    if (!hasError || openedForErrorRef.current) return;
    openedForErrorRef.current = true;
    setAdvancedOpen(true);
  }, [hasError]);

  useEffect(() => {
    onValidityChange?.(valid);
  }, [onValidityChange, valid]);

  const tokens = useMemo(() => {
    try {
      return parseJvmArgs(value);
    } catch {
      return [];
    }
  }, [value]);

  const emit = (next: Draft, markTouched = true) => {
    if (markTouched) touchedRef.current = true;
    const normalizedDraft = next.manualXms
      ? next
      : { ...next, xmsMiB: automaticInitialMemoryMiB(next.presetId, next.xmxMiB) };
    const nextValue = buildDraftValue(normalizedDraft);
    setDraft(normalizedDraft);
    lastEmittedRef.current = nextValue;
    onChange(nextValue);
  };

  const chooseDetectedMode = (choice: Exclude<DetectedJvmChoice, null>) => {
    onDetectedChoiceChange?.(choice);
    // 三种选择都是整份换掉，内存框里没填完的文本不再保留。
    setXmxText(null);
    setXmsText(null);
    if (choice === 'recommended') {
      emit({
        xmsMiB: Math.min(1024, recommendedMaximum),
        xmxMiB: recommendedMaximum,
        presetId: 'compatibility',
        extraArgs: '',
        manualXms: false,
        rawMode: false,
      });
      return;
    }
    if (choice === 'detected' && detectedJvmConfig?.canonicalArgs) {
      const next = draftFromValue(detectedJvmConfig.canonicalArgs);
      loadDraft(next);
      // lastEmittedRef 会让上面的 value effect 跳过这次换入，展开要在这里自己做。
      revealCustomParts(next);
      lastEmittedRef.current = detectedJvmConfig.canonicalArgs;
      onChange(detectedJvmConfig.canonicalArgs);
      return;
    }
    if (choice === 'custom' && detectedJvmConfig) {
      const seed = detectedJvmConfig.canonicalArgs ?? detectedJvmConfig.raw;
      const next = draftFromValue(seed);
      // 检测到的值也算「外面传进来的原值」，填回同样的数时不四舍五入。
      loadedRef.current = { xmxMiB: next.rawMode ? null : next.xmxMiB, xmsMiB: next.rawMode ? null : next.xmsMiB };
      revealCustomParts(next);
      emit(next);
    }
  };

  /** 用户在内存框里打字：文本照原样留着（「4.」这类没输完的也是），能算出合法的数才外发。 */
  const typeMemory = (field: 'xmxMiB' | 'xmsMiB', text: string) => {
    touchedRef.current = true;
    (field === 'xmxMiB' ? setXmxText : setXmsText)(text);
    const parsed = parseMemoryText(text, loadedRef.current[field]);
    if ('mib' in parsed && parsed.mib !== draft[field]) emit({ ...draft, [field]: parsed.mib });
  };
  /** 失焦只整理显示（「4.」变回「4」），不改数值；不合法的文本留着让用户接着改。 */
  const tidyMemory = (field: 'xmxMiB' | 'xmsMiB') => {
    const parsed = field === 'xmxMiB' ? xmxParsed : xmsParsed;
    if (parsed && 'mib' in parsed) (field === 'xmxMiB' ? setXmxText : setXmsText)(null);
  };

  const fieldsDisabled = disabled || needsDetectedChoice;
  // 档位：超出这台电脑内存的不给；推荐值常常不是整数 GB（比如 7.5），并进来一起排。
  const memoryTiers = [...new Set([
    ...MEMORY_TIERS_GB.map((gb) => gb * 1024).filter((mib) => totalMemoryMiB === null || mib <= totalMemoryMiB),
    recommendedMaximum,
  ])].sort((left, right) => left - right);
  const xmxErrorId = `${maximumId}-error`;
  const xmxHelpId = `${maximumId}-help`;
  const xmsErrorId = `${xmsId}-error`;
  const g1JavaMajors = JVM_PRESETS.find((preset) => preset.id === 'g1-balanced')?.supportedJavaMajors;
  const g1Available = javaMajor !== null && (g1JavaMajors?.includes(javaMajor) ?? false);
  const paperAvailable = coreType === 'paper' && g1Available;

  const preview = (
    <div className="jvm-args-preview" aria-label={t('jvm.preview.ariaLabel')}>
      <strong>{t('jvm.preview.title')}</strong>
      {tokens.length > 0 ? (
        <div className="jvm-token-list">
          {tokens.map((token, index) => <code key={`${token}-${index}`}>{token}</code>)}
        </div>
      ) : (
        <code>{value || t('jvm.preview.empty')}</code>
      )}
    </div>
  );

  return (
    <section className="jvm-settings" aria-label={t('jvm.section.ariaLabel')}>
      {detectedJvmConfig && (
        <fieldset className="jvm-detected-choice" disabled={disabled}>
          <legend>{t('jvm.detected.legend')}</legend>
          <label>
            <input
              type="radio"
              name="detected-jvm-choice"
              checked={detectedChoice === 'detected'}
              disabled={!detectedJvmConfig.canonicalArgs}
              onChange={() => chooseDetectedMode('detected')}
            />
            {t('jvm.detected.keep')}
          </label>
          <label>
            <input
              type="radio"
              name="detected-jvm-choice"
              checked={detectedChoice === 'recommended'}
              onChange={() => chooseDetectedMode('recommended')}
            />
            {t('jvm.detected.recommended')}
          </label>
          <label>
            <input
              type="radio"
              name="detected-jvm-choice"
              checked={detectedChoice === 'custom'}
              onChange={() => chooseDetectedMode('custom')}
            />
            {t('jvm.detected.custom')}
          </label>
          {detectedJvmConfig.issues.map((item, index) => (
            <p key={`${item.code}-${index}`} className={item.severity === 'error' ? 'error' : 'field-warn'}>
              {translateJvmIssue(item, tm)}
            </p>
          ))}
        </fieldset>
      )}

      {draft.rawMode ? (
        <div className="field">
          <label htmlFor={extraId}>{t('jvm.raw.label')}</label>
          <textarea
            id={extraId}
            rows={5}
            value={value}
            disabled={fieldsDisabled}
            onChange={(event) => {
              touchedRef.current = true;
              const nextValue = event.target.value;
              lastEmittedRef.current = nextValue;
              onChange(nextValue);
              const parsed = inspectJvmArgs(nextValue);
              if (parsed.canonicalArgs) loadDraft(draftFromValue(parsed.canonicalArgs));
            }}
          />
        </div>
      ) : (
        <>
          <div className="grid grid-2 jvm-basic-grid">
            {/*
              不用 Field 外壳，因为档位要排在输入框和错误之间。错误不能放在档位上面：
              删空后直接点档位时，输入框失焦让错误行冒出来，档位被顶下去，这一下就点空了。
            */}
            <div className="field" data-field-invalid={xmxError ? '' : undefined}>
              <label htmlFor={maximumId}>{t('jvm.memory.max.label')}</label>
              <NumberInput
                id={maximumId}
                decimal
                suffix={t('jvm.memory.unit')}
                value={xmxText ?? gbText(draft.xmxMiB)}
                disabled={fieldsDisabled}
                aria-invalid={xmxFeedback.shown ? true : undefined}
                aria-describedby={[xmxFeedback.shown ? xmxErrorId : null, totalMemoryMiB ? xmxHelpId : null].filter(Boolean).join(' ') || undefined}
                onChange={(text) => typeMemory('xmxMiB', text)}
                onBlur={() => {
                  xmxFeedback.onBlur();
                  tidyMemory('xmxMiB');
                }}
              />
              <div className="jvm-memory-tiers" role="group" aria-label={t('jvm.memory.tiers.ariaLabel')}>
                {memoryTiers.map((mib) => {
                  // 框里的文本不合法时哪一档都不算选中。
                  const selected = !xmxError && draft.xmxMiB === mib;
                  return (
                    <button
                      key={mib}
                      type="button"
                      className={selected ? 'chip is-selected' : 'chip'}
                      aria-pressed={selected}
                      disabled={fieldsDisabled}
                      onClick={() => {
                        setXmxText(null);
                        if (draft.xmxMiB !== mib) emit({ ...draft, xmxMiB: mib });
                      }}
                    >
                      {t('jvm.memory.tier', { value: fmt.number(mib / 1024) })}
                      {mib === recommendedMaximum && <span className="chip-desc">{t('jvm.memory.tier.recommended')}</span>}
                    </button>
                  );
                })}
              </div>
              {xmxFeedback.shown && <p className="error" id={xmxErrorId}>{xmxError}</p>}
              {totalMemoryMiB ? (
                <p className="muted field-help" id={xmxHelpId}>
                  {t('jvm.memory.help.host', { total: fmt.number(Math.round(totalMemoryMiB / 1024)) })}
                </p>
              ) : null}
            </div>
            <div className="field">
              <label htmlFor={presetId}>{t('jvm.preset.label')}</label>
              <select
                id={presetId}
                value={draft.presetId}
                disabled={fieldsDisabled}
                onChange={(event) => {
                  const nextPreset = event.target.value as JvmPresetId;
                  emit({ ...draft, presetId: nextPreset });
                }}
              >
                <option value="compatibility">{t(PRESET_LABEL_KEYS.compatibility)}</option>
                <option value="g1-balanced" disabled={!g1Available}>{t(PRESET_LABEL_KEYS['g1-balanced'])}</option>
                <option value="paper-aikar" disabled={!paperAvailable}>{t(PRESET_LABEL_KEYS['paper-aikar'])}</option>
                <option value="custom">{t('jvm.preset.custom.option')}</option>
              </select>
              <p className="muted field-help">
                {selectedPreset ? t(PRESET_DESCRIPTION_KEYS[selectedPreset.id]) : t('jvm.preset.custom.description')}
              </p>
              {selectedPreset?.sourceUrl ? (
                <p className="muted field-help">
                  {rich(
                    'jvm.preset.source',
                    {
                      link: (chunk) => (
                        <a href={selectedPreset.sourceUrl ?? undefined} target="_blank" rel="noreferrer">{chunk}</a>
                      ),
                    },
                    { version: selectedPreset.version, date: selectedPreset.reviewedAt },
                  )}
                </p>
              ) : null}
            </div>
          </div>

          <details className="disclosure jvm-advanced" open={advancedOpen} onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}>
            <summary>{t('jvm.advanced.summary')}</summary>
            <label className="checkbox-field">
              <input
                type="checkbox"
                checked={draft.manualXms}
                disabled={fieldsDisabled}
                onChange={(event) => {
                  // 关掉手动后初始内存跟着最大内存走，框里没填完的文本不留。
                  setXmsText(null);
                  emit({ ...draft, manualXms: event.target.checked });
                }}
              />
              {t('jvm.xms.manual')}
            </label>
            <div className="field" data-field-invalid={xmsError ? '' : undefined}>
              <label htmlFor={xmsId}>{t('jvm.xms.label')}</label>
              <NumberInput
                id={xmsId}
                decimal
                suffix={t('jvm.memory.unit')}
                value={draft.manualXms ? xmsText ?? gbText(draft.xmsMiB) : gbText(draft.xmsMiB)}
                disabled={fieldsDisabled || !draft.manualXms}
                aria-invalid={xmsFeedback.shown ? true : undefined}
                aria-describedby={xmsFeedback.shown ? xmsErrorId : undefined}
                onChange={(text) => typeMemory('xmsMiB', text)}
                onBlur={() => {
                  xmsFeedback.onBlur();
                  tidyMemory('xmsMiB');
                }}
              />
              {xmsFeedback.shown && <p className="error" id={xmsErrorId}>{xmsError}</p>}
            </div>
            <div className="field">
              <label htmlFor={extraId}>{t('jvm.extra.label')}</label>
              <textarea
                id={extraId}
                rows={4}
                value={draft.extraArgs}
                disabled={fieldsDisabled}
                placeholder={t('jvm.extra.placeholder')}
                onChange={(event) => emit({ ...draft, extraArgs: event.target.value })}
              />
              <p className="muted field-help">{t('jvm.extra.help')}</p>
            </div>
            {preview}
          </details>
        </>
      )}

      {/* 原始文本模式没有折叠区，预览照旧放在外面。 */}
      {draft.rawMode && preview}
      {issues.map((item, index) => (
        <p
          key={`${item.code}-${index}`}
          className={item.severity === 'error' ? 'error' : 'field-warn'}
          role={item.severity === 'error' ? 'alert' : undefined}
        >
          {translateJvmIssue(item, tm)}
        </p>
      ))}
    </section>
  );
}
