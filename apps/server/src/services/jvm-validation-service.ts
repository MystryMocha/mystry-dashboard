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

/** 保存和启动前使用同一套共享规则，并将合法参数规范化后落库。 */
export function normalizeAndAssertJvmArgs(
  value: string,
  input: ServerJvmValidationInput = {},
): string {
  const issue = firstJvmValidationIssue(value, serverJvmValidationContext(input));
  if (issue) {
    // 第一条错误诊断直接作为可翻译错误抛出，文本与诊断一致；没有键的诊断保留原文。
    if (issue.key) throw new PanelError(issue.key, issue.params);
    throw new Error(issue.message);
  }
  return serializeJvmArgs(parseJvmArgs(value));
}
