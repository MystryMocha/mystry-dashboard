import { PackageOpen, Settings, SquareTerminal, TriangleAlert, Users, type LucideIcon } from 'lucide-react';
import type { InstanceInfo } from '@mystry/shared';
import type { I18n } from './i18n';
import { canStartInstance } from './instance-status';

/** Instances that need the user's attention: crashed, pending migration, detached live process, last start failed for a recognizable reason, or the chosen Java is no longer available. */
export function hasIssue(inst: InstanceInfo): boolean {
  return inst.requiresMigration || !!inst.orphanProcess || inst.status === 'crashed' || (canStartInstance(inst.status) && !!inst.startIssue);
}

export type RowState = {
  sentence: string | null;
  tone: 'warn' | 'danger' | null;
  /** `quiet` marks a next step that is not a fix, so it does not compete with the rows that need attention. */
  fix: { to: string; label: string; icon: LucideIcon; quiet?: boolean } | null;
};

/** The sentence after the status, and the one step most worth taking for this instance. */
export function rowState(inst: InstanceInfo, t: I18n['t']): RowState {
  const page = `/instances/${inst.id}`;
  if (inst.requiresMigration) {
    return {
      sentence: t('dashboard.row.migration'),
      tone: 'warn',
      fix: { to: page, label: t('dashboard.row.action.migrate'), icon: PackageOpen },
    };
  }
  if (inst.orphanProcess) {
    return {
      sentence: t('dashboard.row.detached', { pid: inst.orphanProcess.pid }),
      tone: 'warn',
      fix: { to: page, label: t('dashboard.row.action.manageDetached'), icon: TriangleAlert },
    };
  }
  const issue = canStartInstance(inst.status) ? inst.startIssue ?? null : null;
  if (issue?.kind === 'eula') {
    return {
      sentence: t('dashboard.row.eula'),
      tone: 'warn',
      fix: { to: page, label: t('dashboard.row.action.reviewEula'), icon: TriangleAlert },
    };
  }
  if (issue?.kind === 'java-unavailable') {
    return {
      sentence: t('instance.startIssue.javaUnavailable.title'),
      tone: 'warn',
      fix: { to: `${page}/settings`, label: t('instance.startIssue.java.openSettings'), icon: Settings },
    };
  }
  if (issue) {
    return {
      sentence: issue.requiredJava != null
        ? t('instance.startIssue.java.title', { java: issue.requiredJava })
        : t('instance.startIssue.java.titleUnknown'),
      tone: 'warn',
      fix: { to: `${page}/settings`, label: t('instance.startIssue.java.openSettings'), icon: Settings },
    };
  }
  switch (inst.status) {
    case 'crashed':
      return {
        sentence: t('dashboard.row.crashed'),
        tone: 'danger',
        fix: { to: page, label: t('dashboard.row.action.console'), icon: SquareTerminal },
      };
    case 'starting':
      return { sentence: t('dashboard.row.loading'), tone: null, fix: null };
    case 'running':
      return inst.ready
        ? {
          // The Running pill already says the server is up; a second sentence would repeat it.
          sentence: null,
          tone: null,
          fix: { to: `/multiplayer?instance=${encodeURIComponent(inst.id)}`, label: t('instance.ready.action'), icon: Users, quiet: true },
        }
        : { sentence: t('dashboard.row.loading'), tone: null, fix: null };
    case 'stopping':
      return { sentence: t('dashboard.row.stopping'), tone: null, fix: null };
    default:
      return { sentence: null, tone: null, fix: null };
  }
}
