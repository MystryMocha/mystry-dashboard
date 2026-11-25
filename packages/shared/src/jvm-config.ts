import type { CoreType } from './index.js';
import {
  renderPanelMessage,
  type PanelMessage,
  type PanelMessageParams,
  type ServerMessageKey,
} from './messages/index.js';

export type JvmPresetId = 'compatibility' | 'g1-balanced' | 'paper-aikar' | 'custom';

export type JvmValidationIssue = {
  code: string;
  severity: 'error' | 'warning';
  /** The rendered English text; legacy data without a key, and diagnostics from other sources, are shown as is. */
  message: string;
  /** Translatable message key (`server.jvm.issue.*`) and params, which Web shows in the current language. */
  key?: ServerMessageKey;
  params?: PanelMessageParams;
};

/** Failed to parse JVM arguments: the shared package does not depend on the server's PanelError, so this carries its own message key and params; `message` is English text. */
export class JvmArgsParseError extends Error {
  readonly messageKey: ServerMessageKey;
  readonly params?: PanelMessageParams;

  constructor(key: ServerMessageKey, params?: PanelMessageParams) {
    super(renderPanelMessage({ key, params }));
    this.name = 'JvmArgsParseError';
    this.messageKey = key;
    this.params = params;
  }

  toPanelMessage(): PanelMessage {
    return this.params ? { key: this.messageKey, params: this.params } : { key: this.messageKey };
  }
}

export type DetectedJvmConfig = {
  source: 'user_jvm_args.txt';
  raw: string;
  canonicalArgs: string | null;
  issues: JvmValidationIssue[];
};

export type JvmPresetDefinition = {
  id: Exclude<JvmPresetId, 'custom'>;
  label: string;
  description: string;
  version: string;
  supportedCoreTypes: readonly CoreType[] | null;
  supportedJavaMajors: readonly number[] | null;
  sourceUrl: string | null;
  reviewedAt: string;
  args: readonly string[];
};

export type JvmValidationContext = {
  coreType?: CoreType | null;
  javaMajor?: number | null;
  totalMemoryMiB?: number | null;
};

export type ParsedJvmConfig = {
  raw: string;
  args: string[];
  xmsMiB: number | null;
  xmxMiB: number | null;
  presetId: JvmPresetId;
  extraArgs: string;
  canonicalArgs: string | null;
  issues: JvmValidationIssue[];
};

// Java 25 was tested with Temurin 25.0.4.1: both GC presets start normally
const GC_PRESET_JAVA_MAJORS = [8, 17, 21, 25] as const;

const G1_BALANCED_ARGS = [
  '-XX:+UseG1GC',
  '-XX:+ParallelRefProcEnabled',
  '-XX:MaxGCPauseMillis=200',
] as const;

const PAPER_AIKAR_ARGS = [
  '-XX:+UseG1GC',
  '-XX:+ParallelRefProcEnabled',
  '-XX:MaxGCPauseMillis=200',
  '-XX:+UnlockExperimentalVMOptions',
  '-XX:+DisableExplicitGC',
  '-XX:+AlwaysPreTouch',
  '-XX:G1NewSizePercent=30',
  '-XX:G1MaxNewSizePercent=40',
  '-XX:G1HeapRegionSize=8M',
  '-XX:G1ReservePercent=20',
  '-XX:G1HeapWastePercent=5',
  '-XX:G1MixedGCCountTarget=4',
  '-XX:InitiatingHeapOccupancyPercent=15',
  '-XX:G1MixedGCLiveThresholdPercent=90',
  '-XX:G1RSetUpdatingPauseTimePercent=5',
  '-XX:SurvivorRatio=32',
  '-XX:+PerfDisableSharedMem',
  '-XX:MaxTenuringThreshold=1',
  '-Dusing.aikars.flags=https://mcflags.emc.gs',
  '-Daikars.new.flags=true',
] as const;

export const JVM_PRESETS: readonly JvmPresetDefinition[] = [
  {
    id: 'compatibility',
    label: 'Compatibility First',
    description: 'Sets only initial and max memory, with no GC tuning flags.',
    version: '1',
    supportedCoreTypes: null,
    supportedJavaMajors: null,
    sourceUrl: null,
    reviewedAt: '2026-08-11',
    args: [],
  },
  {
    id: 'g1-balanced',
    label: 'G1 Balanced',
    description: 'Uses a conservative G1 pause target. Suits most servers.',
    version: '1',
    supportedCoreTypes: null,
    supportedJavaMajors: GC_PRESET_JAVA_MAJORS,
    sourceUrl: 'https://docs.oracle.com/en/java/javase/22/gctuning/hotspot-virtual-machine-garbage-collection-tuning-guide.pdf',
    reviewedAt: '2026-10-21',
    args: G1_BALANCED_ARGS,
  },
  {
    id: 'paper-aikar',
    label: 'Paper Aikar',
    description: 'The official PaperMC Aikar flags. Allocate at least 6 GiB.',
    version: 'papermc-2026-08-11',
    supportedCoreTypes: ['paper'],
    supportedJavaMajors: GC_PRESET_JAVA_MAJORS,
    sourceUrl: 'https://docs.papermc.io/paper/aikars-flags/',
    reviewedAt: '2026-10-21',
    args: PAPER_AIKAR_ARGS,
  },
] as const;

/** Message keys of the preset names used for the {preset} param in diagnostics (label is the English default; the Web UI translates by preset id). */
const PRESET_LABEL_KEYS: Record<Exclude<JvmPresetId, 'custom'>, ServerMessageKey> = {
  compatibility: 'server.jvm.preset.compatibility',
  'g1-balanced': 'server.jvm.preset.g1Balanced',
  'paper-aikar': 'server.jvm.preset.paperAikar',
};

const GC_SELECTOR_PATTERN = /^-XX:[+-]Use(?:G1|Parallel|Serial|Z|Shenandoah|Epsilon|ConcMarkSweep)GC$/;

const PANEL_OWNED_ARGS = new Set([
  '-jar',
  '-cp',
  '-classpath',
  '--class-path',
  '-m',
  '--module',
  'nogui',
  '--nogui',
  '--disable-@files',
  'java',
  'java.exe',
  'javaw',
  'javaw.exe',
]);

function issue(
  code: string,
  severity: JvmValidationIssue['severity'],
  key: ServerMessageKey,
  params?: PanelMessageParams,
): JvmValidationIssue {
  const message = renderPanelMessage({ key, params });
  return params ? { code, severity, message, key, params } : { code, severity, message, key };
}

/** Turns errors thrown by the parser into diagnostics: keyed parse errors keep their key and params, anything else (which should not happen in theory) keeps its original text. */
function parseErrorIssue(code: string, error: unknown): JvmValidationIssue {
  if (error instanceof JvmArgsParseError) return issue(code, 'error', error.messageKey, error.params);
  return { code, severity: 'error', message: error instanceof Error ? error.message : String(error) };
}

function parseJvmTokens(value: string, unescapeQuotedBackslashes: boolean): string[] {
  const args: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let tokenStarted = false;

  const pushCurrent = () => {
    if (!tokenStarted) return;
    args.push(current);
    current = '';
    tokenStarted = false;
  };

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (quote) {
      if (character === quote) {
        quote = null;
        tokenStarted = true;
        continue;
      }
      if (
        character === '\\'
        && (value[index + 1] === quote || (unescapeQuotedBackslashes && value[index + 1] === '\\'))
      ) {
        current += value[index + 1]!;
        tokenStarted = true;
        index += 1;
        continue;
      }
      current += character;
      tokenStarted = true;
      continue;
    }
    if (/\s/.test(character)) {
      pushCurrent();
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      tokenStarted = true;
      continue;
    }
    if (character === '\\') {
      const next = value[index + 1];
      if (next !== undefined && (/\s/.test(next) || next === '"' || next === "'")) {
        current += next;
        tokenStarted = true;
        index += 1;
        continue;
      }
    }
    current += character;
    tokenStarted = true;
  }

  if (quote) throw new JvmArgsParseError('server.jvm.issue.unclosedQuote');
  pushCurrent();
  return args;
}

/** Parses a user-entered JVM argument string into an argument array that can be passed straight to spawn. */
export function parseJvmArgs(value: string): string[] {
  return parseJvmTokens(value, false);
}

/** Parses an @argfile by the Java launcher's rules, with the panel's stricter validation for unclosed quotes. */
export function parseJvmArgFile(value: string): string[] {
  const args: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let tokenStarted = false;
  let comment = false;

  const pushCurrent = () => {
    if (!tokenStarted) return;
    args.push(current);
    current = '';
    tokenStarted = false;
  };

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (comment) {
      if (character === '\n' || character === '\r') comment = false;
      continue;
    }
    if (quote) {
      if (character === quote) {
        quote = null;
        tokenStarted = true;
        continue;
      }
      if (character === '\r' || character === '\n') continue;
      if (character === '\\') {
        const next = value[index + 1];
        if (next === '\r' || next === '\n') {
          if (next === '\r' && value[index + 2] === '\n') index += 1;
          index += 1;
          while (/[ \t]/.test(value[index + 1] ?? '')) index += 1;
          continue;
        }
        if (next !== undefined) {
          current += next === 'n'
            ? '\n'
            : next === 'r'
              ? '\r'
              : next === 't'
                ? '\t'
                : next === 'f'
                  ? '\f'
                  : next;
          tokenStarted = true;
          index += 1;
          continue;
        }
      }
      current += character;
      tokenStarted = true;
      continue;
    }
    if (character === '#') {
      pushCurrent();
      comment = true;
      continue;
    }
    if (/\s/.test(character)) {
      pushCurrent();
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      tokenStarted = true;
      continue;
    }
    if (character === '\\') {
      const next = value[index + 1];
      if (next === '\r' || next === '\n') {
        if (next === '\r' && value[index + 2] === '\n') index += 1;
        index += 1;
        while (/[ \t]/.test(value[index + 1] ?? '')) index += 1;
        continue;
      }
      if (next !== undefined) {
        current += next;
        tokenStarted = true;
        index += 1;
        continue;
      }
    }
    current += character;
    tokenStarted = true;
  }
  if (quote) throw new JvmArgsParseError('server.jvm.issue.unclosedQuote');
  pushCurrent();
  return args;
}

/** Normalizes an argument array into a single-line string the panel can parse again. */
export function serializeJvmArgs(args: readonly string[]): string {
  return args
    .map((argument) => {
      if (argument === '') return '""';
      return argument.replace(/([\s"'])/g, '\\$1');
    })
    .join(' ');
}

/** Serializes an argument array into a Java @argfile, with each line corresponding to exactly one argument. */
export function serializeJvmArgFile(args: readonly string[]): string {
  return args
    .map((argument) => `"${argument
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r')
      .replace(/\t/g, '\\t')
      .replace(/\f/g, '\\f')}"`)
    .join('\n');
}

function parseMemoryMiB(argument: string, kind: 's' | 'x'): number | null {
  const match = new RegExp(`^-Xm${kind}(\\d+)([kKmMgGtT]?)$`).exec(argument);
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  const multiplier = unit === 'k'
    ? 1 / 1024
    : unit === 'g'
      ? 1024
      : unit === 't'
        ? 1024 * 1024
        : unit === 'm'
          ? 1
          : 1 / (1024 * 1024);
  const result = amount * multiplier;
  return Number.isFinite(result) && result > 0 ? result : null;
}

function presetById(id: JvmPresetId): JvmPresetDefinition | null {
  return JVM_PRESETS.find((preset) => preset.id === id) ?? null;
}

function startsWithArgs(value: readonly string[], prefix: readonly string[]): boolean {
  return prefix.length <= value.length && prefix.every((argument, index) => value[index] === argument);
}

function detectPreset(nonMemoryArgs: readonly string[]): {
  presetId: JvmPresetId;
  extraArgs: string[];
} {
  for (const preset of [...JVM_PRESETS].sort((left, right) => right.args.length - left.args.length)) {
    if (preset.args.length > 0 && startsWithArgs(nonMemoryArgs, preset.args)) {
      return { presetId: preset.id, extraArgs: nonMemoryArgs.slice(preset.args.length) };
    }
  }
  if (nonMemoryArgs.length === 0) return { presetId: 'compatibility', extraArgs: [] };
  return { presetId: 'custom', extraArgs: [...nonMemoryArgs] };
}

export function recommendedMaxMemoryMiB(totalMemoryMiB: number | null | undefined): number {
  if (!totalMemoryMiB || !Number.isFinite(totalMemoryMiB) || totalMemoryMiB <= 0) return 2048;
  const roundedQuarter = Math.floor((totalMemoryMiB * 0.25) / 512) * 512;
  const safeCap = Math.floor((totalMemoryMiB - 2048) / 512) * 512;
  const usualRecommendation = Math.max(2048, Math.min(8192, roundedQuarter));
  return Math.max(1024, Math.min(usualRecommendation, Math.max(1024, safeCap)));
}

/**
 * Initial memory (Xms) when not set manually: G1 Balanced and Paper Aikar are tuning profiles for servers and use the same value as max memory,
 * to avoid repeated heap growth while running; Compatibility First and Custom use 1 GiB (or max memory when that is smaller), so starting a server does not take all the memory at once.
 */
export function automaticInitialMemoryMiB(presetId: JvmPresetId, maximumMiB: number): number {
  return presetId === 'paper-aikar' || presetId === 'g1-balanced' ? maximumMiB : Math.min(1024, maximumMiB);
}

export function validateJvmArgs(
  value: string,
  context: JvmValidationContext = {},
): JvmValidationIssue[] {
  const issues: JvmValidationIssue[] = [];
  if (value.length > 8192) {
    issues.push(issue('ARGS_TOO_LONG', 'error', 'server.jvm.issue.argsTooLong', { max: 8192 }));
  }
  let args: string[];
  try {
    args = parseJvmArgs(value);
  } catch (error) {
    return [parseErrorIssue('PARSE_ERROR', error)];
  }

  const xmsArgs = args.filter((argument) => argument.startsWith('-Xms'));
  const xmxArgs = args.filter((argument) => argument.startsWith('-Xmx'));
  if (xmsArgs.length !== 1) {
    issues.push(issue('XMS_COUNT', 'error', 'server.jvm.issue.xmsCount'));
  }
  if (xmxArgs.length !== 1) {
    issues.push(issue('XMX_COUNT', 'error', 'server.jvm.issue.xmxCount'));
  }

  const xmsMiB = xmsArgs.length === 1 ? parseMemoryMiB(xmsArgs[0]!, 's') : null;
  const xmxMiB = xmxArgs.length === 1 ? parseMemoryMiB(xmxArgs[0]!, 'x') : null;
  if (xmsArgs.length === 1 && xmsMiB === null) {
    issues.push(issue('XMS_FORMAT', 'error', 'server.jvm.issue.xmsFormat'));
  }
  if (xmxArgs.length === 1 && xmxMiB === null) {
    issues.push(issue('XMX_FORMAT', 'error', 'server.jvm.issue.xmxFormat'));
  }
  if (xmsMiB !== null && xmxMiB !== null && xmsMiB > xmxMiB) {
    issues.push(issue('MEMORY_ORDER', 'error', 'server.jvm.issue.memoryOrder'));
  }
  if (xmxMiB !== null && context.totalMemoryMiB && xmxMiB > context.totalMemoryMiB - 2048) {
    issues.push(issue('MEMORY_HIGH', 'warning', 'server.jvm.issue.memoryHigh'));
  }

  for (const argument of args) {
    const normalizedArgument = argument.toLowerCase();
    if (
      PANEL_OWNED_ARGS.has(normalizedArgument)
      || argument.startsWith('@')
      || normalizedArgument.startsWith('--class-path=')
      || normalizedArgument.startsWith('--module=')
    ) {
      issues.push(issue('PANEL_OWNED_ARGUMENT', 'error', 'server.jvm.issue.panelOwnedArgument', { argument }));
    }
  }
  const gcSelectors = args.filter((argument) => GC_SELECTOR_PATTERN.test(argument));
  if (gcSelectors.length > 1) {
    issues.push(issue('GC_CONFLICT', 'error', 'server.jvm.issue.gcConflict'));
  }

  const nonMemoryArgs = args.filter((argument) => !argument.startsWith('-Xms') && !argument.startsWith('-Xmx'));
  const detected = detectPreset(nonMemoryArgs);
  const preset = presetById(detected.presetId);
  const presetLabel: PanelMessage | null = preset ? { key: PRESET_LABEL_KEYS[preset.id] } : null;
  if (preset?.supportedCoreTypes && context.coreType && !preset.supportedCoreTypes.includes(context.coreType)) {
    issues.push(issue('PRESET_CORE_MISMATCH', 'error', 'server.jvm.issue.presetCoreMismatch', {
      preset: presetLabel!,
      cores: preset.supportedCoreTypes.join('/'),
    }));
  }
  if (preset?.supportedJavaMajors) {
    if (context.javaMajor == null) {
      issues.push(issue('JAVA_MAJOR_UNKNOWN', 'warning', 'server.jvm.issue.javaMajorUnknown', { preset: presetLabel! }));
    } else if (!preset.supportedJavaMajors.includes(context.javaMajor)) {
      issues.push(issue('PRESET_JAVA_MISMATCH', 'warning', 'server.jvm.issue.presetJavaMismatch', {
        preset: presetLabel!,
        java: context.javaMajor,
      }));
    }
  }
  if (detected.presetId === 'paper-aikar' && xmsMiB !== null && xmxMiB !== null) {
    if (xmsMiB !== xmxMiB) {
      issues.push(issue('PAPER_MEMORY_MISMATCH', 'error', 'server.jvm.issue.paperMemoryMismatch'));
    }
    if (xmxMiB < 6144) {
      issues.push(issue('PAPER_MEMORY_LOW', 'warning', 'server.jvm.issue.paperMemoryLow'));
    }
  }
  return issues;
}

export function inspectJvmArgs(
  value: string,
  context: JvmValidationContext = {},
): ParsedJvmConfig {
  let args: string[] = [];
  try {
    args = parseJvmArgs(value);
  } catch {
    return {
      raw: value,
      args: [],
      xmsMiB: null,
      xmxMiB: null,
      presetId: 'custom',
      extraArgs: value,
      canonicalArgs: null,
      issues: validateJvmArgs(value, context),
    };
  }
  const xmsArg = args.find((argument) => argument.startsWith('-Xms'));
  const xmxArg = args.find((argument) => argument.startsWith('-Xmx'));
  const nonMemoryArgs = args.filter((argument) => !argument.startsWith('-Xms') && !argument.startsWith('-Xmx'));
  const detected = detectPreset(nonMemoryArgs);
  const issues = validateJvmArgs(value, context);
  return {
    raw: value,
    args,
    xmsMiB: xmsArg ? parseMemoryMiB(xmsArg, 's') : null,
    xmxMiB: xmxArg ? parseMemoryMiB(xmxArg, 'x') : null,
    presetId: detected.presetId,
    extraArgs: serializeJvmArgs(detected.extraArgs),
    canonicalArgs: issues.some((item) => item.severity === 'error') ? null : serializeJvmArgs(args),
    issues,
  };
}

export function inspectJvmArgFile(
  raw: string,
  context: JvmValidationContext = {},
): DetectedJvmConfig {
  try {
    const args = parseJvmArgFile(raw);
    const canonical = serializeJvmArgs(args);
    const issues = validateJvmArgs(canonical, context);
    return {
      source: 'user_jvm_args.txt',
      raw,
      canonicalArgs: issues.some((item) => item.severity === 'error') ? null : canonical,
      issues,
    };
  } catch (error) {
    return {
      source: 'user_jvm_args.txt',
      raw,
      canonicalArgs: null,
      issues: [parseErrorIssue('ARGFILE_PARSE_ERROR', error)],
    };
  }
}

export function buildJvmArgs(input: {
  xmsMiB: number;
  xmxMiB: number;
  presetId: JvmPresetId;
  extraArgs?: string;
}): string {
  const preset = presetById(input.presetId);
  const extra = input.extraArgs?.trim() ? parseJvmArgs(input.extraArgs) : [];
  return serializeJvmArgs([
    `-Xms${Math.round(input.xmsMiB)}M`,
    `-Xmx${Math.round(input.xmxMiB)}M`,
    ...(preset?.args ?? []),
    ...extra,
  ]);
}

/** The first error diagnostic (with message key and params); returns null when there are no errors. */
export function firstJvmValidationIssue(
  value: string,
  context: JvmValidationContext = {},
): JvmValidationIssue | null {
  return validateJvmArgs(value, context).find((item) => item.severity === 'error') ?? null;
}
