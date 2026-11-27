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
 * Translates shared-package JVM diagnostics into the current language: when a diagnostic carries a message key and params (`server.jvm.issue.*`) it is translated by key,
 * with nested params such as preset names translated along; diagnostics without a key (detection errors from other sources or legacy data) fall back to the original text.
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

/** Memory the user enters by hand cannot be lower than this (the original input's min=512); untouched old values are not bound by it. */
const MIN_MEMORY_MIB = 512;
/** Common presets (GB) for max and initial memory, giving only the few most used for running a server; those beyond this computer's memory are not shown. */
const MEMORY_TIERS_GB = [8, 10, 12];
const INITIAL_MEMORY_TIERS_GB = [2, 4, 6];

/** Under these profiles initial memory automatically equals max memory (see automaticInitialMemoryMiB). */
function xmsFollowsMaximum(presetId: JvmPresetId): boolean {
  return presetId === 'g1-balanced' || presetId === 'paper-aikar';
}

/**
 * Converts MiB into the GB text shown in the input: whole GB shows an integer, the rest at most two decimals (2500M shows 2.44).
 * Only ASCII digits and a decimal point are used here, because the input's content has to be parsed back; presets and descriptions shown to people go through fmt.
 */
function gbText(mib: number): string {
  return String(Math.round((mib / 1024) * 100) / 100);
}

type MemoryTextError = 'empty' | 'invalid' | 'min';

/**
 * Converts the GB text the user entered into MiB. `keepMiB` is the original value passed in from outside: when the number entered displays the same as it, the original value is used directly,
 * so 2.44 × 1024 is not rounded to 2499 and 2500M is not rewritten.
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
  /** The user_jvm_args.txt detected in the import source. The parent adopts it automatically on detection; this only shows the notice with "Cancel" and "Reapply". */
  detectedJvmConfig?: DetectedJvmConfig;
  /** Whether the current arguments adopted detectedJvmConfig. */
  detectedApplied?: boolean;
  onDetectedAppliedChange?: (applied: boolean) => void;
  onValidityChange?: (valid: boolean) => void;
  /** true when there are errors or warnings, or the detected user_jvm_args.txt is unusable; the import page expands the collapsed settings based on it. */
  onAttentionChange?: (needsAttention: boolean) => void;
}) {
  const { t, tm, rich, fmt } = useI18n();
  const maximumId = useId();
  const presetId = useId();
  const xmsId = useId();
  const extraId = useId();
  const [draft, setDraft] = useState<Draft>(() => draftFromValue(value));
  // The text the user is typing in the two memory boxes; null means not editing, and the number in draft is displayed.
  // The number is computed from the text only when the user changes this box; every other operation uses the MiB in draft, so 2500M is not rewritten by rounding.
  const [xmxText, setXmxText] = useState<string | null>(null);
  const [xmsText, setXmsText] = useState<string | null>(null);
  // The original value passed in from outside; see parseMemoryText.
  const loadedRef = useRef({ xmxMiB: draft.rawMode ? null : draft.xmxMiB, xmsMiB: draft.rawMode ? null : draft.xmsMiB });
  // The "Advanced JVM arguments" collapsible section (extra arguments and "Final arguments" are inside): expanded on mount or when externally supplied arguments contain extra arguments;
  // it also expands once, one-way, the first time the arguments have an error. It is not made fully controlled, so the user can still collapse it after entering custom arguments.
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

  /** Switching to a config the user did not type in the memory boxes: drops unfinished text in the two boxes. */
  function loadDraft(next: Draft) {
    setDraft(next);
    setXmxText(null);
    setXmsText(null);
    loadedRef.current = { xmxMiB: next.rawMode ? null : next.xmxMiB, xmsMiB: next.rawMode ? null : next.xmsMiB };
  }

  /** When a config swapped in wholesale (passed from outside, adopting a detection result) has extra arguments, the advanced section expands, so they are not submitted while hidden in the collapsible section. */
  function revealCustomParts(next: Draft) {
    if (next.extraArgs.trim() !== '') setAdvancedOpen(true);
  }

  const recommendedMaximum = recommendedMaxMemoryMiB(totalMemoryMiB);

  useEffect(() => {
    if (
      !useRecommendedDefault
      // When the adopted detection result happens to be exactly -Xms1G -Xmx2G, it must not be displaced by the recommended value either.
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

  // When the text in a memory box is invalid nothing is emitted and value stays at the previous valid value; it is merged into valid here, and the parent blocks saving based on it.
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
   * The user types in a memory box: the text is kept as is (including unfinished ones like "4."), and it is emitted only when a valid number can be computed.
   * Changing initial memory counts as setting it manually, and changing max memory afterwards no longer carries it along; it returns to automatic only when switching to G1 Balanced or Paper Aikar.
   */
  const typeMemory = (field: 'xmxMiB' | 'xmsMiB', text: string) => {
    touchedRef.current = true;
    (field === 'xmxMiB' ? setXmxText : setXmsText)(text);
    const parsed = parseMemoryText(text, loadedRef.current[field]);
    if (!('mib' in parsed) || parsed.mib === draft[field]) return;
    emit(field === 'xmsMiB' ? { ...draft, xmsMiB: parsed.mib, manualXms: true } : { ...draft, xmxMiB: parsed.mib });
  };
  /**
   * The up/down arrows in the box and the ↑ ↓ keys: step to the adjacent whole GB (up from 2.44 is 3, down is 2), not below the lower bound;
   * when the text in the box is invalid (for example cleared), it is computed from the previous valid value. It takes the same path as typing, so changing initial memory also counts as setting it manually.
   * Computed from the number displayed in the box, not from MiB: 4100M displays "4", and stepping down from 4.004 would give 4, which is then recognized back as the original 4100M, so pressing would do nothing.
   */
  const stepMemory = (field: 'xmxMiB' | 'xmsMiB', direction: 1 | -1) => {
    const parsed = field === 'xmxMiB' ? xmxParsed : xmsParsed;
    const currentGb = Number(gbText(parsed && 'mib' in parsed ? parsed.mib : draft[field]));
    const nextGb = Math.max(MIN_MEMORY_MIB / 1024, direction === 1 ? Math.floor(currentGb) + 1 : Math.ceil(currentGb) - 1);
    typeMemory(field, String(nextGb));
  };
  /** Blur only tidies the display ("4." back to "4") without changing the number; invalid text is left for the user to keep editing. */
  const tidyMemory = (field: 'xmxMiB' | 'xmsMiB') => {
    const parsed = field === 'xmxMiB' ? xmxParsed : xmsParsed;
    if (parsed && 'mib' in parsed) (field === 'xmxMiB' ? setXmxText : setXmsText)(null);
  };

  const fieldsDisabled = disabled;
  // Presets: those beyond this computer's memory are not offered; all are offered when host memory cannot be read.
  const tiersWithinHost = (gbs: number[]) => gbs
    .map((gb) => gb * 1024)
    .filter((mib) => totalMemoryMiB === null || mib <= totalMemoryMiB);
  const memoryTiers = tiersWithinHost(MEMORY_TIERS_GB);
  const initialMemoryTiers = tiersWithinHost(INITIAL_MEMORY_TIERS_GB);
  const xmxErrorId = `${maximumId}-error`;
  const xmsErrorId = `${xmsId}-error`;
  const xmsHelpId = `${xmsId}-help`;
  // Paper Aikar requires initial memory to equal max memory, so it is locked while automatic; when legacy data has them different (manual) it can still be changed, so the user can correct it.
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
        The detected user_jvm_args.txt has already been adopted automatically by the parent, so only one line of explanation is used here, followed by "Cancel" (after which "Reapply" is available).
        When adopted, the file's own warnings and the diagnostics on the current arguments below are the same set and are not listed again; reasons are listed only when the file is unusable.
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
            {/* Initial and max memory sit side by side in the left column, with the optimization profile in the right column; when the configurator is narrow the profile moves below (see styles.css). */}
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
                            // Clicking a preset is the same as typing in the box and counts as setting it manually.
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
                The Field shell is not used, because the presets have to sit between the input and the error. The error cannot go above the presets:
                when a preset is clicked right after clearing, the input's blur makes the error row pop up, the presets get pushed down, and the click misses.
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
                      // When the text in the box is invalid no preset counts as selected.
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
                  // Switching to G1 Balanced or Paper Aikar: initial memory returns to automatic, equal to max memory; unfinished text in the box is not kept.
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

      {/* Raw text mode has no collapsible section, so the preview stays outside. */}
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
