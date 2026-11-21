import { Link } from 'react-router-dom';
import { Download, Play, Settings, TriangleAlert } from 'lucide-react';
import type { InstanceStartIssue } from '@mystry/shared';
import { MINECRAFT_EULA_URL } from './EulaCheckbox';
import { useI18n } from '../i18n';
import { javaDownloadUrl } from '../java-download';

/**
 * Shown above the console when a start failed for a recognizable reason, or the chosen Java is no longer available: explains the reason and gives the next step.
 * With the EULA not accepted it can be accepted and started here; on a Java version mismatch download and switch entries are given; when Java is unavailable it leads to settings to choose again.
 */
export function StartIssueBanner({
  issue,
  instanceId,
  busy,
  onAgreeEulaAndStart,
}: {
  issue: InstanceStartIssue;
  instanceId: string;
  busy: boolean;
  onAgreeEulaAndStart: () => void;
}) {
  const { t, rich } = useI18n();

  if (issue.kind === 'eula') {
    return (
      <div className="callout callout-warning start-issue" role="alert">
        <TriangleAlert size={18} aria-hidden="true" className="callout-icon" />
        <div>
          <p><strong>{t('instance.startIssue.eula.title')}</strong></p>
          <p>
            {rich('instance.startIssue.eula.body', {
              link: (chunk) => (
                <a href={MINECRAFT_EULA_URL} target="_blank" rel="noreferrer" className="link">
                  {chunk}
                </a>
              ),
            })}
          </p>
          <div className="start-issue-actions">
            <button className="btn btn-primary" type="button" disabled={busy} onClick={onAgreeEulaAndStart}>
              <Play size={14} aria-hidden="true" />
              {t('instance.startIssue.eula.action')}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // The chosen Java is no longer available: not a version problem, so no download entry, only a link to settings to choose again.
  if (issue.kind === 'java-unavailable') {
    return (
      <div className="callout callout-warning start-issue" role="alert">
        <TriangleAlert size={18} aria-hidden="true" className="callout-icon" />
        <div>
          <p><strong>{t('instance.startIssue.javaUnavailable.title')}</strong></p>
          <p>{t('instance.startIssue.javaUnavailable.body')}</p>
          <div className="start-issue-actions">
            <Link className="btn btn-primary" to={`/instances/${instanceId}/settings`}>
              <Settings size={14} aria-hidden="true" />
              {t('instance.startIssue.java.openSettings')}
            </Link>
          </div>
        </div>
      </div>
    );
  }

  const java = issue.requiredJava;
  return (
    <div className="callout callout-warning start-issue" role="alert">
      <TriangleAlert size={18} aria-hidden="true" className="callout-icon" />
      <div>
        <p>
          <strong>
            {java != null ? t('instance.startIssue.java.title', { java }) : t('instance.startIssue.java.titleUnknown')}
          </strong>
        </p>
        <p>
          {java == null
            ? t('instance.startIssue.java.bodyUnknown')
            : t(issue.kind === 'java-too-new' ? 'instance.startIssue.javaTooNew.body' : 'instance.startIssue.javaTooOld.body', { java })}
        </p>
        <div className="start-issue-actions">
          <a className="btn btn-primary" href={javaDownloadUrl(java)} target="_blank" rel="noreferrer">
            <Download size={14} aria-hidden="true" />
            {java != null ? t('java.download.version', { java }) : t('java.download.any')}
          </a>
          <Link className="btn" to={`/instances/${instanceId}/settings`}>
            <Settings size={14} aria-hidden="true" />
            {t('instance.startIssue.java.openSettings')}
          </Link>
        </div>
      </div>
    </div>
  );
}
