import os from 'node:os';
import {
  firstJvmValidationIssue,
  parseJvmArgs,
  serializeJvmArgs,
  type CoreType,
  type JvmValidationContext,
} from '@mystry/shared';
import { PanelError } from '../utils/errors.js';
import { getJavaRuntime } from './java-runtime-service.js';

export type ServerJvmValidationInput = {
  coreType?: CoreType | null;
  javaRuntimeId?: string | null;
};

export function serverJvmValidationContext(
  input: ServerJvmValidationInput = {},
): JvmValidationContext {
  const runtime = input.javaRuntimeId ? getJavaRuntime(input.javaRuntimeId) : null;
  return {
    coreType: input.coreType,
    javaMajor: runtime?.major_version ?? null,
    totalMemoryMiB: Math.round(os.totalmem() / 1024 / 1024),
  };
}

/** The same shared rules are used before saving and before starting, and valid arguments are normalized before being stored. */
export function normalizeAndAssertJvmArgs(
  value: string,
  input: ServerJvmValidationInput = {},
): string {
  const issue = firstJvmValidationIssue(value, serverJvmValidationContext(input));
  if (issue) {
    // The first error diagnostic is thrown directly as a translatable error, with the same text as the diagnostic; diagnostics without a key keep their original text.
    if (issue.key) throw new PanelError(issue.key, issue.params);
    throw new Error(issue.message);
  }
  return serializeJvmArgs(parseJvmArgs(value));
}
