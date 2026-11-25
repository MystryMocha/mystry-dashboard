import { recommendedJavaMajor, type InstanceStartIssue } from '@mystry/shared';

/** The EULA notice printed by the server itself; it must come right after the "]: " of the log prefix, so player chat with <name> does not match. */
const EULA_RE = /\]: You need to agree to the EULA in order to run the server/;
/** The marker line for finished startup; once it has appeared, Java can run this server, and later exits are not attributed to the Java version. */
const STARTED_RE = /\]: Done \(/;
/** The class file version minus 44 is the Java major version (52 → 8, 61 → 17, 65 → 21). */
const CLASS_VERSION_RE = /UnsupportedClassVersionError[^\n]*?class file version (\d+)(?:\.\d+)?/;
const CLASS_VERSION_ERROR_RE = /java\.lang\.UnsupportedClassVersionError/;
/** The notice from cores such as Paper after checking the version themselves. */
const REQUIRES_AT_LEAST_RE = /requires running the server with Java (\d+) or above/;
const SUPPORTED_UP_TO_RE = /Unsupported Java detected \([^)]*\)\. Only up to Java (\d+) is supported/;
/** The fixed error of Forge 1.12.2 and earlier (LaunchWrapper) on Java 9+. */
const LAUNCHWRAPPER_RE = /AppClassLoader cannot be cast to (?:class )?java\.net\.URLClassLoader/;

function javaMajor(value: string | undefined): number | null {
  const major = Number(value);
  return Number.isInteger(major) && major >= 5 && major <= 99 ? major : null;
}

export function hasFinishedStarting(output: string): boolean {
  return STARTED_RE.test(output);
}

/**
 * Determines the startup failure reason from the console output before the process exited. Only fixed sentence patterns of the server or JVM are recognized;
 * returns null when unrecognized, and the UI treats it as an ordinary crash.
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
  // LaunchWrapper runs only on Java 8, so 8 is suggested even when the version number is unknown.
  if (LAUNCHWRAPPER_RE.test(output)) return { kind: 'java-too-new', requiredJava: 8 };

  return null;
}
