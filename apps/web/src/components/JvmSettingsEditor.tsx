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
/** 最大内存、初始内存的常用档位（GB），只给开服最常用的几档；超出这台电脑内存的不显示。 */
const MEMORY_TIERS_GB = [8, 10, 12];
const INITIAL_MEMORY_TIERS_GB = [2, 4, 6];

/** 这几个方案下初始内存自动和最大内存相同（见 automaticInitialMemoryMiB）。 */
function xmsFollowsMaximum(presetId: JvmPresetId): boolean {
  return presetId === 'g1-balanced' || presetId === 'paper-aikar';
}

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
  detectedApplied = false,
  onDetectedAppliedChange,
  onValidityChange,
  onAttentionChange,
}: {
  value: string;
  onChange: (value: string) => void;
  coreType: CoreType;
  javaMajor: number | null;
  disabled?: boolean;
  useRecommendedDefault?: boolean;
  /** 导入来源里检测到的 user_jvm_args.txt。上层检测到就自动沿用，这里只显示提示和「取消」「重新应用」。 */
  detectedJvmConfig?: DetectedJvmConfig;
  /** 当前参数是否沿用了 detectedJvmConfig。 */
  detectedApplied?: boolean;
  onDetectedAppliedChange?: (applied: boolean) => void;
  onValidityChange?: (valid: boolean) => void;
  /** 有错误、有警告，或检测到的 user_jvm_args.txt 用不了时为 true；导入页据此展开收起的设置。 */
  onAttentionChange?: (needsAttention: boolean) => void;
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
  // 「高级 JVM 参数」折叠区（附加参数和「最终参数」在里面）：挂载时或外部换入的参数里有附加参数就展开；
  // 参数第一次出现错误时也单向展开一次。不做成完全受控，用户填了自定义参数后仍能收起。
  const [advancedOpen, setAdvancedOpen] = useState(() => draft.extraArgs.trim() !== '');
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

  /** 整份换入的配置（外部传入、沿用检测结果）带附加参数时展开高级区，免得它藏在折叠区里就被提交。 */
  function revealCustomParts(next: Draft) {
    if (next.extraArgs.trim() !== '') setAdvancedOpen(true);
  }

  const recommendedMaximum = recommendedMaxMemoryMiB(totalMemoryMiB);

  useEffect(() => {
    if (
      !useRecommendedDefault
      // 沿用的检测结果碰巧就是 -Xms1G -Xmx2G 时，也不能被推荐值顶掉。
      || detectedApplied
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
  }, [detectedApplied, draft, onChange, recommendedMaximum, totalMemoryMiB, useRecommendedDefault, value]);

  const issues = useMemo(
    () => validateJvmArgs(value, { coreType, javaMajor, totalMemoryMiB }),
    [coreType, javaMajor, totalMemoryMiB, value],
  );
  const selectedPreset = JVM_PRESETS.find((item) => item.id === draft.presetId) ?? null;

  // 内存框的文本不合法时不外发，value 还是上一个合法值；这里把它并进 valid，上层据此拦住保存。
  const xmxParsed = xmxText === null ? null : parseMemoryText(xmxText, loadedRef.current.xmxMiB);
  const xmsParsed = xmsText === null ? null : parseMemoryText(xmsText, loadedRef.current.xmsMiB);
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
  const valid = !hasError && !xmxError && !xmsError;

  const openedForErrorRef = useRef(false);
  useEffect(() => {
    if (!hasError || openedForErrorRef.current) return;
    openedForErrorRef.current = true;
    setAdvancedOpen(true);
  }, [hasError]);

  useEffect(() => {
    onValidityChange?.(valid);
  }, [onValidityChange, valid]);

  const needsAttention = !valid || issues.length > 0 || Boolean(detectedJvmConfig && !detectedJvmConfig.canonicalArgs);
  useEffect(() => {
    onAttentionChange?.(needsAttention);
  }, [needsAttention, onAttentionChange]);

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

  /**
   * 用户在内存框里打字：文本照原样留着（「4.」这类没输完的也是），能算出合法的数才外发。
   * 改了初始内存就算手动设置，之后改最大内存不再带着它走；换到 G1 均衡或 Paper Aikar 时才回到自动。
   */
  const typeMemory = (field: 'xmxMiB' | 'xmsMiB', text: string) => {
    touchedRef.current = true;
    (field === 'xmxMiB' ? setXmxText : setXmsText)(text);
    const parsed = parseMemoryText(text, loadedRef.current[field]);
    if (!('mib' in parsed) || parsed.mib === draft[field]) return;
    emit(field === 'xmsMiB' ? { ...draft, xmsMiB: parsed.mib, manualXms: true } : { ...draft, xmxMiB: parsed.mib });
  };
  /**
   * 框里的上下箭头和 ↑ ↓ 键：走到相邻的整数 GB（2.44 往上是 3、往下是 2），不低于下限；
   * 框里的文本不合法（比如删空了）时从上一个合法值算。和打字走同一条路，所以改初始内存也算手动设置。
   * 按框里显示的数算，不按 MiB 算：4100M 显示「4」，按 4.004 算往下会得到 4，又被认回原值 4100M，按了没反应。
   */
  const stepMemory = (field: 'xmxMiB' | 'xmsMiB', direction: 1 | -1) => {
    const parsed = field === 'xmxMiB' ? xmxParsed : xmsParsed;
    const currentGb = Number(gbText(parsed && 'mib' in parsed ? parsed.mib : draft[field]));
    const nextGb = Math.max(MIN_MEMORY_MIB / 1024, direction === 1 ? Math.floor(currentGb) + 1 : Math.ceil(currentGb) - 1);
    typeMemory(field, String(nextGb));
  };
  /** 失焦只整理显示（「4.」变回「4」），不改数值；不合法的文本留着让用户接着改。 */
  const tidyMemory = (field: 'xmxMiB' | 'xmsMiB') => {
    const parsed = field === 'xmxMiB' ? xmxParsed : xmsParsed;
    if (parsed && 'mib' in parsed) (field === 'xmxMiB' ? setXmxText : setXmsText)(null);
  };

  const fieldsDisabled = disabled;
  // 档位：超出这台电脑内存的不给；读不到主机内存时全给。
  const tiersWithinHost = (gbs: number[]) => gbs
    .map((gb) => gb * 1024)
    .filter((mib) => totalMemoryMiB === null || mib <= totalMemoryMiB);
  const memoryTiers = tiersWithinHost(MEMORY_TIERS_GB);
  const initialMemoryTiers = tiersWithinHost(INITIAL_MEMORY_TIERS_GB);
  const xmxErrorId = `${maximumId}-error`;
  const xmsErrorId = `${xmsId}-error`;
  const xmsHelpId = `${xmsId}-help`;
  // Paper Aikar 要求初始内存和最大内存相同，自动时锁住；旧数据里两者不同（手动）时仍可改，好让用户改对。
  const xmsLocked = draft.presetId === 'paper-aikar' && !draft.manualXms;
  const xmsHelpKey: MessageKey | null = draft.presetId === 'paper-aikar'
    ? 'jvm.xms.help.paper'
    : draft.presetId === 'g1-balanced' && !draft.manualXms ? 'jvm.xms.help.g1' : null;
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
      {/*
        检测到的 user_jvm_args.txt 已由上层自动沿用，这里只用一行说明，后面跟「取消」（取消后可「重新应用」）。
        沿用时文件自带的警告和下面对当前参数的诊断是同一批，不再重复列出；文件用不了时才列出原因。
      */}
      {detectedJvmConfig && (
        <div className={detectedJvmConfig.canonicalArgs ? 'callout callout-info jvm-detected' : 'callout callout-warning jvm-detected'}>
          <div>
            <p>
              {t(
                !detectedJvmConfig.canonicalArgs ? 'jvm.detected.unusable'
                  : detectedApplied ? 'jvm.detected.applied' : 'jvm.detected.ignored',
                { source: detectedJvmConfig.source },
              )}
            </p>
            {!detectedJvmConfig.canonicalArgs && detectedJvmConfig.issues.map((item, index) => (
              <p key={`${item.code}-${index}`} className="field-help">{translateJvmIssue(item, tm)}</p>
            ))}
          </div>
          {detectedJvmConfig.canonicalArgs && onDetectedAppliedChange && (
            <button
              type="button"
              className="btn btn-sm btn-plain"
              disabled={disabled}
              onClick={() => onDetectedAppliedChange(!detectedApplied)}
            >
              {t(detectedApplied ? 'jvm.detected.undo' : 'jvm.detected.reapply')}
            </button>
          )}
        </div>
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
          <div className="grid jvm-basic-grid">
            {/* 初始内存和最大内存并排占左列，优化方案在右列；配置器窄时优化方案排到下面（见 styles.css）。 */}
            <div className="jvm-memory-pair">
              <div className="field" data-field-invalid={xmsError ? '' : undefined}>
                <label htmlFor={xmsId}>{t('jvm.xms.label')}</label>
                <NumberInput
                  id={xmsId}
                  decimal
                  suffix={t('jvm.memory.unit')}
                  value={xmsLocked ? gbText(draft.xmsMiB) : xmsText ?? gbText(draft.xmsMiB)}
                  disabled={fieldsDisabled || xmsLocked}
                  stepper={{
                    increaseLabel: t('jvm.xms.increase'),
                    decreaseLabel: t('jvm.xms.decrease'),
                    onStep: (direction) => stepMemory('xmsMiB', direction),
                  }}
                  aria-invalid={xmsFeedback.shown ? true : undefined}
                  aria-describedby={[xmsFeedback.shown ? xmsErrorId : null, xmsHelpKey ? xmsHelpId : null].filter(Boolean).join(' ') || undefined}
                  onChange={(text) => typeMemory('xmsMiB', text)}
                  onBlur={() => {
                    xmsFeedback.onBlur();
                    tidyMemory('xmsMiB');
                  }}
                />
                {initialMemoryTiers.length > 0 && (
                  <div className="jvm-memory-tiers" role="group" aria-label={t('jvm.xms.tiers.ariaLabel')}>
                    {initialMemoryTiers.map((mib) => {
                      const selected = !xmsError && draft.xmsMiB === mib;
                      return (
                        <button
                          key={mib}
                          type="button"
                          className={selected ? 'chip is-selected' : 'chip'}
                          aria-pressed={selected}
                          disabled={fieldsDisabled || xmsLocked}
                          onClick={() => {
                            // 点档位和在框里填一样，算手动设置。
                            setXmsText(null);
                            if (draft.xmsMiB !== mib || !draft.manualXms) emit({ ...draft, xmsMiB: mib, manualXms: true });
                          }}
                        >
                          {t('jvm.memory.tier', { value: fmt.number(mib / 1024) })}
                        </button>
                      );
                    })}
                  </div>
                )}
                {xmsFeedback.shown && <p className="error" id={xmsErrorId}>{xmsError}</p>}
                {xmsHelpKey && <p className="muted field-help" id={xmsHelpId}>{t(xmsHelpKey)}</p>}
              </div>
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
                  stepper={{
                    increaseLabel: t('jvm.memory.max.increase'),
                    decreaseLabel: t('jvm.memory.max.decrease'),
                    onStep: (direction) => stepMemory('xmxMiB', direction),
                  }}
                  aria-invalid={xmxFeedback.shown ? true : undefined}
                  aria-describedby={xmxFeedback.shown ? xmxErrorId : undefined}
                  onChange={(text) => typeMemory('xmxMiB', text)}
                  onBlur={() => {
                    xmxFeedback.onBlur();
                    tidyMemory('xmxMiB');
                  }}
                />
                {memoryTiers.length > 0 && (
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
                        </button>
                      );
                    })}
                  </div>
                )}
                {xmxFeedback.shown && <p className="error" id={xmxErrorId}>{xmxError}</p>}
              </div>
            </div>
            <div className="field">
              <label htmlFor={presetId}>{t('jvm.preset.label')}</label>
              <select
                id={presetId}
                value={draft.presetId}
                disabled={fieldsDisabled}
                onChange={(event) => {
                  const nextPreset = event.target.value as JvmPresetId;
                  // 换到 G1 均衡或 Paper Aikar：初始内存回到自动，和最大内存相同；框里没填完的文本不留。
                  if (xmsFollowsMaximum(nextPreset)) {
                    setXmsText(null);
                    emit({ ...draft, presetId: nextPreset, manualXms: false });
                    return;
                  }
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
