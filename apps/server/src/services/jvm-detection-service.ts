import fs from 'node:fs';
import {
  inspectJvmArgFile,
  renderPanelMessage,
  type CoreType,
  type DetectedJvmConfig,
  type PanelMessage,
} from '@mystry/shared';
import { resolveSafePath } from '../utils/path.js';
import { errorParam } from '../utils/errors.js';

export const MAX_DETECTED_JVM_ARGS_BYTES = 64 * 1024;

function detectionError(message: PanelMessage): DetectedJvmConfig {
  return {
    source: 'user_jvm_args.txt',
    raw: '',
    canonicalArgs: null,
    issues: [{
      code: 'ARGFILE_READ_ERROR',
      severity: 'error',
      message: renderPanelMessage(message),
      key: message.key,
      ...(message.params ? { params: message.params } : {}),
    }],
  };
}

export function jvmConfigFileFingerprint(root: string): string {
  const file = resolveSafePath(root, 'user_jvm_args.txt');
  try {
    const stat = fs.lstatSync(file);
    return `${stat.isFile() && !stat.isSymbolicLink()}:${stat.size}:${stat.mtimeMs}`;
  } catch {
    return 'missing';
  }
}

/** Reads only a regular user_jvm_args.txt in the instance root, without following links. */
export function detectJvmConfigFile(
  root: string,
  coreType?: CoreType | null,
): DetectedJvmConfig | undefined {
  const file = resolveSafePath(root, 'user_jvm_args.txt');
  if (!fs.existsSync(file)) return undefined;
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    return detectionError({ key: 'server.imports.jvmFile.readFailed', params: { reason: errorParam(error) } });
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    return detectionError({ key: 'server.imports.jvmFile.notRegular' });
  }
  if (stat.size > MAX_DETECTED_JVM_ARGS_BYTES) {
    return detectionError({ key: 'server.imports.jvmFile.tooLarge' });
  }
  try {
    return inspectJvmArgFile(fs.readFileSync(file, 'utf8'), { coreType });
  } catch (error) {
    return detectionError({ key: 'server.imports.jvmFile.readFailed', params: { reason: errorParam(error) } });
  }
}
