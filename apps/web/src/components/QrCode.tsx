import { useMemo } from 'react';
import qrcode from 'qrcode-generator';

/** Number of quiet-zone modules around the code; the QR code spec requires at least 4. */
const QUIET_ZONE = 4;

/** Byte mode, error correction level M, with the version chosen automatically by the library. Returns the module matrix; returns null when the content is too long to fit. */
export function qrMatrix(text: string): boolean[][] | null {
  try {
    const code = qrcode(0, 'M');
    // The library's byte mode takes the low 8 bits of each character code, which would truncate Chinese: convert to UTF-8 bytes first and pass those in.
    const bytes = new TextEncoder().encode(text);
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    code.addData(binary, 'Byte');
    code.make();
    const size = code.getModuleCount();
    return Array.from({ length: size }, (_unused, row) =>
      Array.from({ length: size }, (_inner, col) => code.isDark(row, col)));
  } catch {
    return null;
  }
}

/**
 * Generates the QR code locally in the browser, without calling an external service. The module matrix is drawn as SVG here, without using the HTML assembled by the library.
 * Always dark code on a white background with a quiet zone, not inverted for the dark theme, to make sure it scans.
 */
export function QrCode({ value, label, size = 200 }: { value: string; label: string; size?: number }) {
  const matrix = useMemo(() => qrMatrix(value), [value]);
  if (!matrix) return null;
  const total = matrix.length + QUIET_ZONE * 2;
  // Consecutive dark modules in each row are merged into one path segment, with far fewer nodes than one rectangle each.
  let path = '';
  matrix.forEach((row, y) => {
    let start = -1;
    for (let x = 0; x <= row.length; x += 1) {
      const dark = x < row.length && row[x];
      if (dark && start < 0) start = x;
      if (!dark && start >= 0) {
        path += `M${start + QUIET_ZONE} ${y + QUIET_ZONE}h${x - start}v1h-${x - start}z`;
        start = -1;
      }
    }
  });
  return (
    <svg
      className="qr-code"
      role="img"
      aria-label={label}
      width={size}
      height={size}
      viewBox={`0 0 ${total} ${total}`}
      shapeRendering="crispEdges"
    >
      <rect width={total} height={total} fill="#ffffff" />
      <path d={path} fill="#000000" />
    </svg>
  );
}
