import { Link } from 'react-router-dom';
import { ChevronRight, FolderDown, Plus, Zap, type LucideIcon } from 'lucide-react';
import { useI18n, type MessageKey } from '../i18n';

/**
 * When there are no instances yet: one row for each way to add one, explaining which situation each suits.
 * Creating an empty instance needs the dialog on the instances page, so the row appears only where a handler is given.
 */
export function StartPaths({ onCreateEmpty }: { onCreateEmpty?: () => void }) {
  const { t } = useI18n();
  const paths: Array<{ key: string; icon: LucideIcon; title: MessageKey; desc: MessageKey; to?: string }> = [
    { key: 'deploy', icon: Plus, title: 'nav.deploy', desc: 'dashboard.empty.deploy.desc', to: '/deploy' },
    { key: 'import', icon: FolderDown, title: 'nav.import', desc: 'dashboard.empty.import.desc', to: '/import' },
    ...(onCreateEmpty
      ? [{ key: 'empty', icon: Zap, title: 'dashboard.action.createEmpty', desc: 'dashboard.empty.createEmpty.desc' } as const]
      : []),
  ];
  return (
    <div className="start-paths card">
      <div className="start-paths-head">
        <h3>{t('empty.instances.title')}</h3>
        <p>{t('dashboard.empty.lead')}</p>
      </div>
      <ul className="start-path-list">
        {paths.map((path) => {
          const Icon = path.icon;
          const body = (
            <>
              <span className="start-path-icon" aria-hidden="true"><Icon size={18} /></span>
              <span className="start-path-text">
                <span className="start-path-title">{t(path.title)}</span>
                <span className="start-path-desc">{t(path.desc)}</span>
              </span>
              <ChevronRight size={16} aria-hidden="true" className="start-path-chevron" />
            </>
          );
          return (
            <li key={path.key}>
              {path.to ? (
                <Link to={path.to} className="start-path">{body}</Link>
              ) : (
                <button type="button" className="start-path" onClick={onCreateEmpty}>{body}</button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
