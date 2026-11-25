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

// Core names are technical terms and not translated; a custom jar has no fixed name and uses a string key.
const CORE_NAMES: Record<Exclude<CoreType, 'custom'>, string> = {
  paper: 'Paper',
  fabric: 'Fabric',
  forge: 'Forge',
  neoforge: 'NeoForge',
  vanilla: 'Vanilla',
};

/** Core display name: shared by the overview list and the instance page header, so one does not say "Custom Jar" while the other shows the raw custom. */
export function coreDisplayName(coreType: CoreType, t: I18n['t']): string {
  return coreType === 'custom' ? t('dashboard.row.core.custom') : CORE_NAMES[coreType] ?? coreType;
}

/** Core type icon: each core has one fixed color, making them easy to tell apart in a list at a glance. */
export function CoreIcon({ coreType, size = 'md' }: { coreType: CoreType; size?: 'md' | 'lg' }) {
  const Glyph = CORE_GLYPHS[coreType] ?? Package;
  return (
    <span className={`core-icon core-${coreType} core-icon-${size}`} aria-hidden="true">
      <Glyph size={size === 'lg' ? 26 : 20} strokeWidth={2} />
    </span>
  );
}
