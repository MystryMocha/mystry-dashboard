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

/** 文案固定、无参数的诊断 code。 */
const STATIC_ISSUE_KEYS: Record<string, MessageKey> = {
  ARGS_TOO_LONG: 'jvm.issue.argsTooLong',
  XMS_COUNT: 'jvm.issue.xmsCount',
  XMX_COUNT: 'jvm.issue.xmxCount',
  XMS_FORMAT: 'jvm.issue.xmsFormat',
  XMX_FORMAT: 'jvm.issue.xmxFormat',
  MEMORY_ORDER: 'jvm.issue.memoryOrder',
  MEMORY_HIGH: 'jvm.issue.memoryHigh',
  GC_CONFLICT: 'jvm.issue.gcConflict',
  PAPER_MEMORY_MISMATCH: 'jvm.issue.paperMemoryMismatch',
  PAPER_MEMORY_LOW: 'jvm.issue.paperMemoryLow',
};

/** 共享包解析器抛出的错误原文 → 键（PARSE_ERROR / ARGFILE_PARSE_ERROR 的 message 即错误原文）。 */
const PARSE_ERROR_KEYS: Record<string, MessageKey> = {
  'JVM 参数包含未闭合的引号': 'jvm.issue.unclosedQuote',
};

/**
 * 把共享包 validateJvmArgs 生成的诊断翻译为当前语言。
 * 带参数的 code 从中文原文中提取参数（服务端检测结果与前端校验使用同一套原文）；
 * 未知 code 或原文格式对不上时回落显示原文。
 */
function translateJvmIssue(item: JvmValidationIssue, t: I18n['t']): string {
  const presetLabel = (label: string) => {
    const preset = JVM_PRESETS.find((candidate) => candidate.label === label);
    return preset ? t(PRESET_LABEL_KEYS[preset.id]) : label;
  };
  const staticKey = STATIC_ISSUE_KEYS[item.code];
  if (staticKey) return t(staticKey);
  switch (item.code) {
    case 'PARSE_ERROR':
    case 'ARGFILE_PARSE_ERROR': {
      const key = PARSE_ERROR_KEYS[item.message];
      return key ? t(key) : item.message;
    }
    case 'PANEL_OWNED_ARGUMENT': {
      const match = /^参数 ([\s\S]+) 由面板管理，不能写入 JVM 参数$/.exec(item.message);
      return match ? t('jvm.issue.panelOwnedArgument', { argument: match[1]! }) : item.message;
    }
    case 'PRESET_CORE_MISMATCH': {
      const match = /^(.+) 仅适用于 (.+) 核心$/.exec(item.message);
      return match
        ? t('jvm.issue.presetCoreMismatch', { preset: presetLabel(match[1]!), cores: match[2]! })
        : item.message;
    }
    case 'JAVA_MAJOR_UNKNOWN': {
      const match = /^(.+) 尚未确认所选 Java 版本是否兼容$/.exec(item.message);
      return match ? t('jvm.issue.javaMajorUnknown', { preset: presetLabel(match[1]!) }) : item.message;
    }
    case 'PRESET_JAVA_MISMATCH': {
      const match = /^(.+) 未验证支持 Java (\S+)$/.exec(item.message);
      return match
        ? t('jvm.issue.presetJavaMismatch', { preset: presetLabel(match[1]!), java: match[2]! })
        : item.message;
    }
    default:
      return item.message;
  }
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
  const { t, rich } = useI18n();
  const maximumId = useId();
  const presetId = useId();
  const xmsId = useId();
  const extraId = useId();
  const [draft, setDraft] = useState<Draft>(() => draftFromValue(value));
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
    setDraft(draftFromValue(value));
  }, [value]);

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
    setDraft(next);
    lastEmittedRef.current = nextValue;
    onChange(nextValue);
  }, [draft, onChange, recommendedMaximum, totalMemoryMiB, useRecommendedDefault, value]);

  const issues = useMemo(
    () => validateJvmArgs(value, { coreType, javaMajor, totalMemoryMiB }),
    [coreType, javaMajor, totalMemoryMiB, value],
  );
  const selectedPreset = JVM_PRESETS.find((item) => item.id === draft.presetId) ?? null;
  const needsDetectedChoice = Boolean(detectedJvmConfig && detectedChoice === null);
  const valid = !needsDetectedChoice && !issues.some((item) => item.severity === 'error');

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
      setDraft(next);
      lastEmittedRef.current = detectedJvmConfig.canonicalArgs;
      onChange(detectedJvmConfig.canonicalArgs);
      return;
    }
    if (choice === 'custom' && detectedJvmConfig) {
      const seed = detectedJvmConfig.canonicalArgs ?? detectedJvmConfig.raw;
      const next = draftFromValue(seed);
      emit(next);
    }
  };

  const fieldsDisabled = disabled || needsDetectedChoice;
  const g1JavaMajors = JVM_PRESETS.find((preset) => preset.id === 'g1-balanced')?.supportedJavaMajors;
  const g1Available = javaMajor !== null && (g1JavaMajors?.includes(javaMajor) ?? false);
  const paperAvailable = coreType === 'paper' && g1Available;

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
              {translateJvmIssue(item, t)}
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
              if (parsed.canonicalArgs) setDraft(draftFromValue(parsed.canonicalArgs));
            }}
          />
        </div>
      ) : (
        <>
          <div className="grid grid-2 jvm-basic-grid">
            <div className="field">
              <label htmlFor={maximumId}>{t('jvm.memory.max.label')}</label>
              <input
                id={maximumId}
                type="number"
                min={512}
                step={512}
                value={draft.xmxMiB}
                disabled={fieldsDisabled}
                onChange={(event) => {
                  const next = Number(event.target.value);
                  if (Number.isFinite(next) && next > 0) emit({ ...draft, xmxMiB: next });
                }}
              />
              <p className="muted field-help">
                {totalMemoryMiB
                  ? t('jvm.memory.help.withHost', {
                    recommended: recommendedMaximum,
                    total: Math.round(totalMemoryMiB / 1024),
                  })
                  : t('jvm.memory.help.noHost', { recommended: recommendedMaximum })}
              </p>
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

          <details className="disclosure jvm-advanced">
            <summary>{t('jvm.advanced.summary')}</summary>
            <label className="checkbox-field">
              <input
                type="checkbox"
                checked={draft.manualXms}
                disabled={fieldsDisabled}
                onChange={(event) => emit({ ...draft, manualXms: event.target.checked })}
              />
              {t('jvm.xms.manual')}
            </label>
            <div className="field">
              <label htmlFor={xmsId}>{t('jvm.xms.label')}</label>
              <input
                id={xmsId}
                type="number"
                min={512}
                step={512}
                value={draft.xmsMiB}
                disabled={fieldsDisabled || !draft.manualXms}
                onChange={(event) => {
                  const next = Number(event.target.value);
                  if (Number.isFinite(next) && next > 0) emit({ ...draft, xmsMiB: next });
                }}
              />
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
          </details>
        </>
      )}

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
      {issues.map((item, index) => (
        <p
          key={`${item.code}-${index}`}
          className={item.severity === 'error' ? 'error' : 'field-warn'}
          role={item.severity === 'error' ? 'alert' : undefined}
        >
          {translateJvmIssue(item, t)}
        </p>
      ))}
    </section>
  );
}
