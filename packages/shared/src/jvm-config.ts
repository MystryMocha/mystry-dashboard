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
  /** 渲染好的英文文本；没有 key 的旧数据或其他来源的诊断直接显示原文。 */
  message: string;
  /** 可翻译消息键（`server.jvm.issue.*`）与参数，Web 按当前语言显示。 */
  key?: ServerMessageKey;
  params?: PanelMessageParams;
};

/** 解析 JVM 参数失败：共享包不依赖服务端 PanelError，这里自带消息键与参数，`message` 为英文文本。 */
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

// Java 25 已用 Temurin 25.0.4.1 实测：两套 GC 预设参数均可正常启动
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

/** 诊断里 {preset} 参数使用的预设名称消息键（label 为英文默认值，Web 界面按预设 id 翻译）。 */
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

/** 解析器抛出的错误转成诊断：带键的解析错误保留键与参数，其余（理论上不会出现）保留原文。 */
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

/** 把用户输入的 JVM 参数字符串解析为可直接传给 spawn 的参数数组。 */
export function parseJvmArgs(value: string): string[] {
  return parseJvmTokens(value, false);
}

/** 按 Java 启动器规则解析 @argfile，并对未闭合引号使用更严格的面板校验。 */
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

/** 将参数数组规范化成面板可再次解析的单行字符串。 */
export function serializeJvmArgs(args: readonly string[]): string {
  return args
    .map((argument) => {
      if (argument === '') return '""';
      return argument.replace(/([\s"'])/g, '\\$1');
    })
    .join(' ');
}

/** 把参数数组序列化为 Java @argfile，每行严格对应一个参数。 */
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
 * 没手动设置时的初始内存（Xms）：G1 均衡和 Paper Aikar 是给服务器调优的方案，和最大内存相同，
 * 免得运行中反复扩堆；兼容优先和自定义取 1 GiB（最大内存更小时取最大内存），开服时不一下子占满内存。
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

/** 第一条错误诊断（含消息键与参数）；没有错误时返回 null。 */
export function firstJvmValidationIssue(
  value: string,
  context: JvmValidationContext = {},
): JvmValidationIssue | null {
  return validateJvmArgs(value, context).find((item) => item.severity === 'error') ?? null;
}

export function firstJvmValidationError(
  value: string,
  context: JvmValidationContext = {},
): string | null {
  return firstJvmValidationIssue(value, context)?.message ?? null;
}
