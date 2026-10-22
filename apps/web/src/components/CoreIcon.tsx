import { Box, Feather, Flame, Hammer, Package, ScrollText, type LucideIcon } from 'lucide-react';
import type { CoreType } from '@mystry/shared';

const CORE_GLYPHS: Record<CoreType, LucideIcon> = {
  paper: ScrollText,
  fabric: Feather,
  forge: Hammer,
  neoforge: Flame,
  vanilla: Box,
  custom: Package,
};

/** 核心类型图标：每种核心固定一种渐变色，便于在列表里一眼区分。 */
export function CoreIcon({ coreType, size = 'md' }: { coreType: CoreType; size?: 'md' | 'lg' }) {
  const Glyph = CORE_GLYPHS[coreType] ?? Package;
  return (
    <span className={`core-icon core-${coreType} core-icon-${size}`} aria-hidden="true">
      <Glyph size={size === 'lg' ? 26 : 20} strokeWidth={2} />
    </span>
  );
}
