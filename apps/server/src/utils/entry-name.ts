/** What is wrong with a name; null when the panel may create an entry under it. */
export type EntryNameIssue = 'empty' | 'tooLong' | 'invalidCharacter' | 'trailingDotOrSpace' | 'reserved';

export const MAX_ENTRY_NAME_LENGTH = 255;

const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;

/**
 * Checks one name (a single path segment) the panel is about to create a file or directory under.
 *
 * Control characters and separators are refused everywhere. The Windows rules apply on Windows only, where Node creates such
 * entries without complaint and Explorer and most programs can then neither open nor delete them: the characters `<>:"|?*`
 * (a colon would also address an alternate data stream), a trailing dot or space, and device names such as CON or NUL, with
 * or without an extension.
 */
export function checkEntryName(name: string, platform: NodeJS.Platform = process.platform): EntryNameIssue | null {
  if (!name || name === '.' || name === '..') return 'empty';
  if (name.length > MAX_ENTRY_NAME_LENGTH) return 'tooLong';
  if (/[\u0000-\u001f\u007f/\\]/.test(name)) return 'invalidCharacter';
  if (platform === 'win32') {
    if (/[<>:"|?*]/.test(name)) return 'invalidCharacter';
    if (/[. ]$/.test(name)) return 'trailingDotOrSpace';
    if (WINDOWS_RESERVED_NAME.test(name)) return 'reserved';
  }
  return null;
}
