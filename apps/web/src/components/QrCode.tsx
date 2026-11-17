import { useMemo } from 'react';
import qrcode from 'qrcode-generator';

/** 四周留白的模块数；二维码规范要求至少 4 个。 */
const QUIET_ZONE = 4;

/** 字节模式、纠错等级 M，版本号由库自动选。返回模块矩阵；内容太长放不下时返回 null。 */
export function qrMatrix(text: string): boolean[][] | null {
  try {
    const code = qrcode(0, 'M');
    // 库的字节模式按字符码的低 8 位取值，中文会被截断：先转成 UTF-8 字节再交给它。
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
 * 在浏览器本地生成二维码，不调用外部服务。自己把模块矩阵画成 SVG，不用库拼好的 HTML。
 * 固定黑码白底、四周留白，不跟随深色主题反色，保证能扫。
 */
export function QrCode({ value, label, size = 200 }: { value: string; label: string; size?: number }) {
  const matrix = useMemo(() => qrMatrix(value), [value]);
  if (!matrix) return null;
  const total = matrix.length + QUIET_ZONE * 2;
  // 每行里连续的深色模块合成一段路径，节点数远少于逐个矩形。
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
