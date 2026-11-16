import { recommendedJavaMajor, type InstanceStartIssue } from '@mystry/shared';

/** 服务端自己打印的 EULA 提示；前面必须紧跟日志前缀的「]: 」，玩家聊天内容带 <名字> 不会命中。 */
const EULA_RE = /\]: You need to agree to the EULA in order to run the server/;
/** 服务端完成启动的标志行；出现过就说明 Java 能跑这个服务端，之后的退出不归因于 Java 版本。 */
const STARTED_RE = /\]: Done \(/;
/** class 文件版本号减 44 即 Java 主版本（52 → 8，61 → 17，65 → 21）。 */
const CLASS_VERSION_RE = /UnsupportedClassVersionError[^\n]*?class file version (\d+)(?:\.\d+)?/;
const CLASS_VERSION_ERROR_RE = /java\.lang\.UnsupportedClassVersionError/;
/** Paper 等核心自己检查版本后的提示。 */
const REQUIRES_AT_LEAST_RE = /requires running the server with Java (\d+) or above/;
const SUPPORTED_UP_TO_RE = /Unsupported Java detected \([^)]*\)\. Only up to Java (\d+) is supported/;
/** 1.12.2 及更早的 Forge（LaunchWrapper）在 Java 9+ 上的固定报错。 */
const LAUNCHWRAPPER_RE = /AppClassLoader cannot be cast to (?:class )?java\.net\.URLClassLoader/;

function javaMajor(value: string | undefined): number | null {
  const major = Number(value);
  return Number.isInteger(major) && major >= 5 && major <= 99 ? major : null;
}

/**
 * 从进程退出前的控制台输出判断启动失败原因。只认服务端或 JVM 的固定句式，
 * 认不出时返回 null，由界面按普通崩溃处理。
 */
export function diagnoseStartFailure(output: string, mcVersion: string | null): InstanceStartIssue | null {
  if (EULA_RE.test(output)) return { kind: 'eula', requiredJava: null };
  if (STARTED_RE.test(output)) return null;

  const recommended = recommendedJavaMajor(mcVersion);

  const classVersion = CLASS_VERSION_RE.exec(output);
  if (classVersion) {
    const required = javaMajor(String(Number(classVersion[1]) - 44));
    return { kind: 'java-too-old', requiredJava: required ?? recommended };
  }
  const atLeast = REQUIRES_AT_LEAST_RE.exec(output);
  if (atLeast) return { kind: 'java-too-old', requiredJava: javaMajor(atLeast[1]) ?? recommended };
  if (CLASS_VERSION_ERROR_RE.test(output)) return { kind: 'java-too-old', requiredJava: recommended };

  const upTo = SUPPORTED_UP_TO_RE.exec(output);
  if (upTo) return { kind: 'java-too-new', requiredJava: javaMajor(upTo[1]) ?? recommended };
  // LaunchWrapper 只能在 Java 8 上运行，版本号未知时也按 8 提示。
  if (LAUNCHWRAPPER_RE.test(output)) return { kind: 'java-too-new', requiredJava: 8 };

  return null;
}
