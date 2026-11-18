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
  const { t, tm, rich } = useI18n();
  const maximumId = useId();
  const presetId = useId();
  const xmsId = useId();
  const extraId = useId();
  const [draft, setDraft] = useState<Draft>(() => draftFromValue(value));
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
    setDraft(next);
    // 外部换入的参数（如导入时选择沿用检测到的配置）带自定义部分时展开，免得用户自己的参数被藏起来。
    if (next.manualXms || next.extraArgs.trim() !== '') setAdvancedOpen(true);
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
  const hasError = issues.some((item) => item.severity === 'error');
  const valid = !needsDetectedChoice && !hasError;

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

          <details className="disclosure jvm-advanced" open={advancedOpen} onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}>
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
