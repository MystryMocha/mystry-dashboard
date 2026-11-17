import { Box, Feather, Flame, Hammer, Package, ScrollText, type LucideIcon } from 'lucide-react';
import type { CoreType } from '@mystry/shared';
import type { I18n } from '../i18n';

const CORE_GLYPHS: Record<CoreType, LucideIcon> = {
  paper: ScrollText,
  fabric: Feather,
  forge: Hammer,
  neoforge: Flame,
  vanilla: Box,
  custom: Package,
};

// 核心名是技术名词不翻译；自定义 jar 没有固定名称，用文案键。
const CORE_NAMES: Record<Exclude<CoreType, 'custom'>, string> = {
  paper: 'Paper',
  fabric: 'Fabric',
  forge: 'Forge',
  neoforge: 'NeoForge',
  vanilla: 'Vanilla',
};

/** 核心显示名：总览列表和实例页头共用，避免一处写「自定义 Jar」、另一处显示原始的 custom。 */
export function coreDisplayName(coreType: CoreType, t: I18n['t']): string {
  return coreType === 'custom' ? t('dashboard.row.core.custom') : CORE_NAMES[coreType] ?? coreType;
}

/** 核心类型图标：每种核心固定一种渐变色，便于在列表里一眼区分。 */
export function CoreIcon({ coreType, size = 'md' }: { coreType: CoreType; size?: 'md' | 'lg' }) {
  const Glyph = CORE_GLYPHS[coreType] ?? Package;
  return (
    <span className={`core-icon core-${coreType} core-icon-${size}`} aria-hidden="true">
      <Glyph size={size === 'lg' ? 26 : 20} strokeWidth={2} />
    </span>
  );
}
