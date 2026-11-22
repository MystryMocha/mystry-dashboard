import fs from 'node:fs';
import { resolveSafePath } from '../utils/path.js';

/** eula.txt is a two-line properties file; anything larger is not the file the server writes, and is not read. */
export const MAX_EULA_FILE_BYTES = 64 * 1024;

/**
 * Whether eula.txt text records acceptance, read as java.util.Properties and Boolean.parseBoolean would: the last `eula` key wins,
 * and its value is `true` in any case with nothing around it. When this says yes the import page stops asking, so a file the server
 * might read differently must count as not accepted: otherwise the user is not asked and the server then refuses to start.
 */
export function isEulaAcceptedText(text: string): boolean {
  // Properties joins a line ending in a backslash to the next one and unescapes values; such files are not the plain one the server writes.
  if (text.includes('\\')) return false;
  let value: string | null = null;
  for (const rawLine of text.split(/\r\n|\r|\n/)) {
    const line = rawLine.replace(/^[ \t\f]+/, '');
    if (line === '' || line.startsWith('#') || line.startsWith('!')) continue;
    const match = /^eula(?:[ \t\f]*[=:][ \t\f]*|[ \t\f]+)(.*)$/.exec(line);
    if (match) value = match[1]!;
  }
  return value !== null && value.toLowerCase() === 'true';
}

/** Reads only a regular eula.txt in the server root, without following links; a missing or unreadable file counts as not accepted. */
export function hasAcceptedEula(root: string): boolean {
  try {
    const file = resolveSafePath(root, 'eula.txt');
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > MAX_EULA_FILE_BYTES) return false;
    return isEulaAcceptedText(fs.readFileSync(file, 'utf8'));
  } catch {
    return false;
  }
}

/** Changes whenever eula.txt is edited, so a cached precheck of the folder (keyed by the folder's own mtime, which an edit leaves alone) is redone. */
export function eulaFileFingerprint(root: string): string {
  try {
    const stat = fs.lstatSync(resolveSafePath(root, 'eula.txt'));
    return `${stat.isFile() && !stat.isSymbolicLink()}:${stat.size}:${stat.mtimeMs}`;
  } catch {
    return 'missing';
  }
}
