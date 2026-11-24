import { useCallback, useState } from 'react';
import { Link } from 'react-router-dom';
import { ShieldAlert } from 'lucide-react';
import type { InstanceStatus } from '@mystry/shared';
import { api, ApiError, instanceApi } from '../api';
import { usePolling } from '../hooks/usePolling';
import { useI18n } from '../i18n';

/** How many players whitelist.json lists; null when it cannot be read or parsed, so the notice claims nothing. */
async function whitelistedPlayerCount(instanceId: string): Promise<number | null> {
  try {
    const { content } = await api<{ content: string }>(
      instanceApi(instanceId, `/files/content?path=${encodeURIComponent('whitelist.json')}`),
    );
    const entries: unknown = JSON.parse(content);
    return Array.isArray(entries) ? entries.length : null;
  } catch (err) {
    // The server creates whitelist.json when it starts; until then the list is empty.
    if (err instanceof ApiError && err.messageI18n?.key === 'server.files.fileNotFound') return 0;
    return null;
  }
}

/**
 * Says so when server.properties has the whitelist on and whitelist.json lists no one, because then every player is turned away
 * (Paper 26.3 writes white-list=true on its first start). The panel does not change either setting: it names the two ways out and
 * leaves the choice to the user. A server whose whitelist already lists players is the owner's own setup and gets no notice.
 */
export function WhitelistNotice({
  instanceId,
  status,
  linkConsole,
  className,
}: {
  instanceId: string;
  status: InstanceStatus;
  /** Off above the console itself, where a link to the console would point at the same page. */
  linkConsole: boolean;
  className?: string;
}) {
  const { t, rich } = useI18n();
  const [visible, setVisible] = useState(false);

  // status is a dependency so the check runs again as soon as the server starts or stops: the first start is when the key appears.
  const load = useCallback(async () => {
    try {
      const properties = await api<Record<string, string>>(instanceApi(instanceId, '/config/server.properties'));
      if (properties['white-list']?.trim().toLowerCase() !== 'true') {
        setVisible(false);
        return;
      }
      setVisible((await whitelistedPlayerCount(instanceId)) === 0);
    } catch {
      setVisible(false);
    }
  }, [instanceId, status]);
  // Polled so the notice goes away once a player has been added from the console.
  usePolling(load);

  if (!visible) return null;
  const instancePath = `/instances/${encodeURIComponent(instanceId)}`;
  return (
    <div className={`callout callout-warning${className ? ` ${className}` : ''}`} role="status">
      <ShieldAlert size={18} aria-hidden="true" className="callout-icon" />
      <div>
        <p><strong>{t('instance.whitelist.title')}</strong> {t('instance.whitelist.body')}</p>
        <p>
          {rich('instance.whitelist.add', {
            cmd: (chunk) => <code>{chunk}</code>,
            console: (chunk) => (linkConsole ? <Link className="link" to={instancePath}>{chunk}</Link> : chunk),
          })}
        </p>
        <p>
          {rich('instance.whitelist.off', {
            config: (chunk) => <Link className="link" to={`${instancePath}/config`}>{chunk}</Link>,
          })}
        </p>
      </div>
    </div>
  );
}
