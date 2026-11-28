import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC_DIR = fileURLToPath(new URL('../src/', import.meta.url));

interface Stylesheet {
  file: string;
  text: string;
}

function findStylesheets(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) return findStylesheets(target);
    return entry.name.endsWith('.css') ? [target] : [];
  });
}

// Comments are blanked rather than removed so reported line numbers still match the file,
// and so a comment that explains a banned pattern does not trip the rule it documents.
function blankComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ' '));
}

const stylesheets: Stylesheet[] = findStylesheets(SRC_DIR).map((file) => ({
  file: path.relative(SRC_DIR, file).split(path.sep).join('/'),
  text: blankComments(readFileSync(file, 'utf8')),
}));

function matches(pattern: RegExp, accept: (match: RegExpMatchArray) => boolean = () => false): string[] {
  const found: string[] = [];
  for (const { file, text } of stylesheets) {
    for (const match of text.matchAll(pattern)) {
      if (accept(match)) continue;
      const line = text.slice(0, match.index).split('\n').length;
      found.push(`${file}:${line}  ${match[0].replace(/\s+/g, ' ').trim()}`);
    }
  }
  return found;
}

describe('stylesheet rules that keep text and edges sharp', () => {
  it('finds the stylesheets', () => {
    expect(stylesheets.map((sheet) => sheet.file)).toContain('styles.css');
  });

  it('surfaces are opaque: no backdrop blur and no blue-tinted translucent gray', () => {
    expect(matches(/backdrop-filter\s*:[^;}]*/g)).toEqual([]);
    expect(matches(/rgba\(\s*120\s*,\s*120\s*,\s*128\s*,[^)]*\)/g)).toEqual([]);
  });

  // A half-pixel line is drawn as a gray smear at 1x and at the fractional display scales
  // Windows uses (125%, 150%, 175%).
  it('borders, outlines and shadows never use a half-pixel width', () => {
    expect(matches(/(?:border|outline|box-shadow)[\w-]*\s*:[^;}]*?(?<![\d.])0?\.5px[^;}]*/g)).toEqual([]);
  });

  // Forcing grayscale smoothing turns off ClearType subpixel rendering on Windows.
  it('font smoothing and text rendering are left to the platform', () => {
    expect(matches(/font-smoothing\s*:[^;}]*/g)).toEqual([]);
    expect(matches(/text-rendering\s*:\s*optimizeLegibility/g)).toEqual([]);
  });

  // The "UI" variants are the condensed dialog faces, and a leading system-ui resolves to
  // them on Windows under a zh-* language.
  it('font stacks avoid the condensed CJK dialog faces and keep system-ui last', () => {
    expect(matches(/Microsoft (?:YaHei|JhengHei) UI/g)).toEqual([]);
    expect(matches(/system-ui(?!\s*,\s*(?:sans-serif|monospace)\s*[;}])[^;}]*/g)).toEqual([]);
  });

  it('font sizes come from the --text-* scale, and every step of the scale is a whole pixel', () => {
    const allowed = /^(?:var\(--text-[a-z]+\)|inherit)(?:\s*!important)?$/;
    expect(
      matches(/(?<![\w-])font-size\s*:\s*([^;}]+)/g, (match) => allowed.test(match[1].trim())),
    ).toEqual([]);
    expect(matches(/--text-[a-z]+\s*:\s*([^;}]+)/g, (match) => /^\d+px$/.test(match[1].trim()))).toEqual([]);
  });
});
