import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Plus } from 'lucide-react';
import type { FrpEndpoint, FrpRuntimeInfo, InstanceTunnel, TunnelMode, TunnelStatus } from '@mystry/shared';
import { FRP_TRANSPORTS } from '@mystry/shared';
import {
  createFrpEndpoint,
  deleteFrpEndpoint,
  fetchFriendTunnelConfig,
  getFrpRuntime,
  getInstanceTunnel,
  installFrpRuntime,
  listFrpEndpoints,
  saveInstanceTunnel,
  uploadFrpRuntime,
} from '../api';
import { copyText } from '../clipboard';
import { errorMessage } from '../errors';
import { usePolling } from '../hooks/usePolling';
import { useI18n, type MessageKey } from '../i18n';
import { frpHostIssue, frpTokenIssue, portIssue } from '../validation';
import { StatusPill, type StatusTone } from './StatusPill';
import { ConfirmDialog } from './ConfirmDialog';
import { Field, FormFeedbackProvider, focusField, focusFirstInvalidField, useFormFeedback } from './Field';
import { NumberInput } from './NumberInput';
import { PasswordInput } from './PasswordInput';
import { RuntimeInstallCallout } from './RuntimeArchiveUpload';
import { FlashNote, JoinAddressStep, JoinSteps, MultiplayerLayout, OpenSwitch, useFlash, type GuideControl } from './MultiplayerLayout';

const STATUS_KEY: Record<TunnelStatus, MessageKey> = {
  disabled: 'multiplayer.status.disabled',
  stopped: 'multiplayer.status.stopped',
  starting: 'multiplayer.status.starting',
  running: 'multiplayer.status.running',
  error: 'multiplayer.status.error',
};

function statusTone(status: TunnelStatus): StatusTone {
  if (status === 'running') return 'running';
  if (status === 'starting') return 'starting';
  if (status === 'error') return 'crashed';
  return 'stopped';
}
interface EndpointDraft {
  name: string;
  serverAddr: string;
  serverPort: string;
  visitHost: string;
  transport: (typeof FRP_TRANSPORTS)[number];
  tls: boolean;
  token: string;
}

interface TunnelDraft {
  endpointId: string;
  mode: TunnelMode;
  remotePort: string;
  visitorBindPort: string;
}

const EMPTY_ENDPOINT: EndpointDraft = {
  name: '',
  serverAddr: '',
  serverPort: '7000',
  visitHost: '',
  transport: 'tcp',
  tls: true,
  token: '',
};

/** Why the primary button is disabled: the first field to fix or fill in. */
interface Blocker {
  id: string;
  label: string;
  /** fix: filled in but non-compliant; fill: a required item is still empty. */
  kind: 'fix' | 'fill';
}

/** Looks for one filled in wrong first (the same one focusFirstInvalidField finds), then for an empty required item. checks are in the order of the fields on the page. */
function firstBlocker(checks: { id: string; label: string; invalid: boolean; empty: boolean }[]): Blocker | null {
  const invalid = checks.find((check) => check.invalid);
  if (invalid) return { id: invalid.id, label: invalid.label, kind: 'fix' };
  const empty = checks.find((check) => check.empty);
  return empty ? { id: empty.id, label: empty.label, kind: 'fill' } : null;
}

/**
 * Pressing Enter in an input equals clicking the primary button. While the primary button is disabled the browser does not trigger submit, so the form handles it itself;
 * only inputs are handled, buttons and dropdowns are not intercepted, and the Enter that confirms an IME candidate does not count either.
 */
function submitOnEnter(event: KeyboardEvent<HTMLFormElement>, submit: () => void): void {
  // Safari's Enter that confirms a candidate does not carry isComposing and can only be recognized by keyCode 229.
  if (event.key !== 'Enter' || event.nativeEvent.isComposing || event.keyCode === 229) return;
  if (!(event.target instanceof HTMLInputElement)) return;
  // Enter on a checkbox does not count as a submit.
  if (event.target.type === 'checkbox' || event.target.type === 'radio') return;
  event.preventDefault();
  submit();
}

function tunnelDraft(tunnel: InstanceTunnel, endpoints: FrpEndpoint[]): TunnelDraft {
  return {
    endpointId: tunnel.endpointId ?? endpoints[0]?.id ?? '',
    mode: tunnel.mode,
    remotePort: String(tunnel.remotePort ?? tunnel.localPort),
    visitorBindPort: String(tunnel.visitorBindPort),
  };
}

/**
 * Instance frp tunneling: only configures the official frpc; raw config or executable paths are not offered.
 * When there is no frp server yet the add form is shown first; once there is one, the order is "switch → let players join → tunnel settings → add server".
 * The first time, a server and tunnel mode have to be chosen and saved before the switch can be used, so a port is not opened on the frp server with defaults nobody looked at.
 */
export function MultiplayerTab({ instanceId, guide }: { instanceId: string; guide: GuideControl }) {
  const { t, tm } = useI18n();
  const [endpoints, setEndpoints] = useState<FrpEndpoint[]>([]);
  const [runtime, setRuntime] = useState<FrpRuntimeInfo | null>(null);
  const [tunnel, setTunnel] = useState<InstanceTunnel | null>(null);
  const [endpointDraft, setEndpointDraft] = useState<EndpointDraft>(EMPTY_ENDPOINT);
  const [draft, setDraft] = useState<TunnelDraft | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  // The result of copying the join instructions / player config is shown below the button.
  const [copied, showCopied] = useFlash();
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [adding, setAdding] = useState(false);
  // The tunnel settings collapsible section: on the first read, collapsed if already open to players, expanded if not.
  const [settingsOpen, setSettingsOpen] = useState<boolean | null>(null);
  useEffect(() => {
    if (tunnel && settingsOpen === null) setSettingsOpen(!tunnel.enabled);
  }, [tunnel, settingsOpen]);
  // The two forms each have their own "are errors showing" state and do not affect each other.
  const endpointFeedback = useFormFeedback();
  const tunnelFeedback = useFormFeedback();
  const endpointFormRef = useRef<HTMLFormElement>(null);
  const tunnelFormRef = useRef<HTMLFormElement>(null);
  const loadError = useRef(false);
  const refresh = useCallback(async () => {
    try {
      const [nextEndpoints, nextRuntime, nextTunnel] = await Promise.all([
        listFrpEndpoints(),
        getFrpRuntime(),
        getInstanceTunnel(instanceId),
      ]);
      setEndpoints(nextEndpoints);
      setRuntime(nextRuntime);
      setTunnel(nextTunnel);
      setDraft((current) => current ?? tunnelDraft(nextTunnel, nextEndpoints));
      if (loadError.current) {
        loadError.current = false;
        setError('');
      }
    } catch (err) {
      loadError.current = true;
      setError(errorMessage(err));
    }
  }, [instanceId]);

  usePolling(refresh);

  // Add frp server: name, address, port and token are required, and the port and address formats match the server.
  // An empty required item does not count as filled in wrong (not marked red); it only disables the primary button, with the text beside the button saying which to fill in.
  const endpointIssues = {
    address: frpHostIssue(endpointDraft.serverAddr),
    port: endpointDraft.serverPort.trim() === '' ? null : portIssue(endpointDraft.serverPort),
    visitHost: frpHostIssue(endpointDraft.visitHost),
    token: frpTokenIssue(endpointDraft.token),
  };
  const endpointBlocker = firstBlocker([
    { id: 'frp-name', label: t('multiplayer.endpoint.name'), invalid: false, empty: endpointDraft.name.trim() === '' },
    { id: 'frp-visit', label: t('multiplayer.endpoint.visitHost'), invalid: endpointIssues.visitHost !== null, empty: false },
    { id: 'frp-address', label: t('multiplayer.endpoint.address'), invalid: endpointIssues.address !== null, empty: endpointDraft.serverAddr.trim() === '' },
    { id: 'frp-port', label: t('multiplayer.endpoint.port'), invalid: endpointIssues.port !== null, empty: endpointDraft.serverPort.trim() === '' },
    { id: 'frp-token', label: t('multiplayer.endpoint.token'), invalid: endpointIssues.token !== null, empty: endpointDraft.token === '' },
  ]);
  // Tunnel settings validate only the port the current mode uses; the other port's input is not on the page, and its draft takes no part in validation and is not submitted.
  const tunnelPortText = draft ? (draft.mode === 'public' ? draft.remotePort : draft.visitorBindPort) : '';
  const tunnelPortIssue = tunnelPortText.trim() === '' ? null : portIssue(tunnelPortText);
  const tunnelBlocker = draft ? firstBlocker([
    { id: 'frp-endpoint', label: t('multiplayer.section.server'), invalid: false, empty: draft.endpointId.length === 0 },
    {
      id: draft.mode === 'public' ? 'frp-remote' : 'frp-visitor',
      label: t(draft.mode === 'public' ? 'multiplayer.tunnel.remotePort' : 'multiplayer.tunnel.visitorPort'),
      invalid: tunnelPortIssue !== null,
      empty: tunnelPortText.trim() === '',
    },
  ]) : null;

  /** When it cannot submit: makes all fields show their reasons and jumps to the first one to fix; when nothing is wrong and it is just empty, jumps to the first one to fill in. */
  function showBlocker(blocker: Blocker, feedback: typeof endpointFeedback, form: HTMLFormElement | null) {
    feedback.revealAll();
    if (!focusFirstInvalidField(form)) focusField(blocker.id);
  }

  function submitEndpoint() {
    if (busy) return;
    if (endpointBlocker) showBlocker(endpointBlocker, endpointFeedback, endpointFormRef.current);
    else void saveEndpoint();
  }

  function submitTunnel() {
    if (busy) return;
    if (tunnelBlocker) showBlocker(tunnelBlocker, tunnelFeedback, tunnelFormRef.current);
    else void saveTunnel();
  }

  async function saveEndpoint() {
    const port = Number(endpointDraft.serverPort);
    if (endpointBlocker || !Number.isInteger(port)) return;
    setBusy(true);
    setNotice('');
    try {
      const created = await createFrpEndpoint({
        name: endpointDraft.name,
        serverAddr: endpointDraft.serverAddr,
        serverPort: port,
        visitHost: endpointDraft.visitHost,
        transport: endpointDraft.transport,
        tls: endpointDraft.tls,
        token: endpointDraft.token,
      });
      setEndpointDraft(EMPTY_ENDPOINT);
      endpointFeedback.reset();
      setAdding(false);
      setError('');
      setDraft((current) => current ? { ...current, endpointId: created.id } : current);
      await refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function removeEndpoint() {
    if (!draft?.endpointId) return;
    setBusy(true);
    setConfirmDelete(false);
    try {
      const deletedId = draft.endpointId;
      await deleteFrpEndpoint(deletedId);
      // When other servers remain, switch to the first: the dropdown would display it anyway, and with an empty value it would look selected yet fail to save.
      const nextId = endpoints.find((endpoint) => endpoint.id !== deletedId)?.id ?? '';
      setDraft((current) => current ? { ...current, endpointId: nextId } : current);
      setError('');
      await refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function toggleTunnel(next: boolean) {
    if (!tunnel?.endpointId) return;
    setBusy(true);
    setNotice('');
    try {
      // Toggle with the tunnel settings saved on the server, without the unsaved changes in the form below.
      setTunnel(await saveInstanceTunnel(instanceId, {
        enabled: next,
        endpointId: tunnel.endpointId,
        mode: tunnel.mode,
        ...(tunnel.mode === 'public' && tunnel.remotePort != null ? { remotePort: tunnel.remotePort } : {}),
        visitorBindPort: tunnel.visitorBindPort,
      }));
      setError('');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function saveTunnel() {
    if (!draft || !tunnel || tunnelBlocker) return;
    // The first save (no server chosen yet) is "Save and Open": the user has already seen the port and mode in the form and need not go back to the top to flip the switch.
    const openNow = !tunnel.endpointId && Boolean(runtime?.installed);
    const remotePort = Number(draft.remotePort);
    // In public port mode the "player local port" input is not on the page: the value saved on the server is kept, and an invisible draft is not submitted.
    // This field cannot be omitted; the server treats omission as the default 25565 and would overwrite the saved port.
    const visitorBindPort = draft.mode === 'public' ? tunnel.visitorBindPort : Number(draft.visitorBindPort);
    setBusy(true);
    setNotice('');
    try {
      // Afterwards the switch is saved separately; only the tunnel settings change here, and the open state follows the server's current state.
      const saved = await saveInstanceTunnel(instanceId, {
        enabled: openNow || tunnel.enabled,
        endpointId: draft.endpointId,
        mode: draft.mode,
        ...(draft.mode === 'public' ? { remotePort } : {}),
        visitorBindPort,
      });
      setTunnel(saved);
      setDraft(tunnelDraft(saved, endpoints));
      tunnelFeedback.reset();
      if (openNow) setSettingsOpen(false);
      setNotice(t('multiplayer.saved'));
      setError('');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function friendText(): Promise<string> {
    return fetchFriendTunnelConfig(instanceId);
  }

  async function copyFriend() {
    setBusy(true);
    try {
      if (!await copyText(await friendText())) throw new Error(t('multiplayer.copyFailed'));
      showCopied(t('multiplayer.tunnel.copied'));
      setError('');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function downloadFriend() {
    setBusy(true);
    try {
      const text = await friendText();
      const url = URL.createObjectURL(new Blob([text], { type: 'application/toml' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = 'friend-frpc.toml';
      link.click();
      URL.revokeObjectURL(url);
      setError('');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function install() {
    setBusy(true);
    try {
      setRuntime(await installFrpRuntime());
      setError('');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function upload(file: File) {
    setBusy(true);
    setUploading(true);
    try {
      setRuntime(await uploadFrpRuntime(file));
      setTunnel(await getInstanceTunnel(instanceId));
      setNotice(t('multiplayer.runtime.uploaded'));
      setError('');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setUploading(false);
      setBusy(false);
    }
  }

  const needsClient = Boolean(runtime?.platformSupported && !runtime.installed);
  const installed = Boolean(runtime?.installed);
  const serverIsNext = !needsClient && endpoints.length === 0;
  const hasEndpoints = Boolean(draft) && endpoints.length > 0;
  // With no server yet the add form is expanded directly; with servers it is collapsed and expands only on "Add frp Server".
  const showEndpointForm = !hasEndpoints || adding;
  // When tunnel settings have never been saved (no server chosen) the switch is not shown, and the save button is "Save and Open".
  const configured = Boolean(tunnel?.endpointId);
  // Before the first read completes it is unknown whether there are frp servers, so neither layout is drawn yet, so the add form does not flash and then switch to the tunnel settings.
  const loading = tunnel === null && !error;

  const guideContent = (
    <>
      <h3>{t('multiplayer.guide.frp.modes')}</h3>
      <ul>
        <li>{t('multiplayer.guide.frp.public')}</li>
        <li>{t('multiplayer.guide.frp.stcp')}</li>
        <li>{t('multiplayer.guide.frp.xtcp')}</li>
      </ul>
    </>
  );

  // In public port mode players connect straight to the address, which is a single step; STCP / XTCP need the player config sent over first.
  const joinSteps = tunnel && (tunnel.mode === 'public'
    ? [<JoinAddressStep address={tunnel.joinAddress} />]
    : [
      <>
        <p>{t('multiplayer.tunnel.step.send')}</p>
        <div className="instance-actions">
          <button className={installed ? 'btn btn-primary' : 'btn'} type="button" disabled={busy} onClick={() => void copyFriend()}>{t('multiplayer.tunnel.copy')}</button>
          <button className="btn" type="button" disabled={busy} onClick={() => void downloadFriend()}>{t('multiplayer.tunnel.friend')}</button>
        </div>
        <p className="field-help">{t('multiplayer.tunnel.friendHelp')}</p>
        <FlashNote text={copied} />
      </>,
      <p>{t('multiplayer.tunnel.step.run')}</p>,
      <JoinAddressStep address={tunnel.joinAddress} />,
    ]);

  /** The sentence beside the button: when the primary button is disabled it says which item to fix first, and clicking jumps there and shows the reason. */
  function blockerHint(blocker: Blocker | null, feedback: typeof endpointFeedback, form: { current: HTMLFormElement | null }) {
    if (!blocker || busy) return null;
    return (
      <button className="link-button multiplayer-form-hint" type="button" onClick={() => showBlocker(blocker, feedback, form.current)}>
        {t(blocker.kind === 'fix' ? 'multiplayer.form.fix' : 'multiplayer.form.fill', { field: blocker.label })}
      </button>
    );
  }

  // The tunnel settings form: expanded directly on the page the first time, and placed in the collapsible section once saved; the two places differ only in the outer class name.
  const tunnelForm = (className: string) => draft && (
    <FormFeedbackProvider value={tunnelFeedback.value}>
      <form
        ref={tunnelFormRef}
        className={className}
        noValidate
        onSubmit={(event: FormEvent) => { event.preventDefault(); submitTunnel(); }}
        onKeyDown={(event) => submitOnEnter(event, submitTunnel)}
      >
        <Field id="frp-endpoint" label={t('multiplayer.section.server')}>
          {(control) => (
            // What gets deleted is the server selected in the dropdown, so the button sits next to it.
            <div className="remote-host-row">
              <select {...control} value={draft.endpointId} disabled={busy} onChange={(event) => setDraft({ ...draft, endpointId: event.target.value })}>
                {endpoints.map((endpoint) => (
                  <option key={endpoint.id} value={endpoint.id}>{endpoint.name}</option>
                ))}
              </select>
              <button className="btn btn-plain is-danger" type="button" disabled={busy || draft.endpointId.length === 0} onClick={() => setConfirmDelete(true)}>
                {t('multiplayer.endpoint.delete')}
              </button>
            </div>
          )}
        </Field>
        <div className="grid grid-2">
          <Field id="frp-mode" label={t('multiplayer.tunnel.mode')}>
            {(control) => (
              <select {...control} value={draft.mode} disabled={busy} onChange={(event) => setDraft({ ...draft, mode: event.target.value as TunnelMode })}>
                <option value="public">{t('multiplayer.tunnel.mode.public')}</option>
                <option value="stcp">{t('multiplayer.tunnel.mode.stcp')}</option>
                <option value="xtcp">{t('multiplayer.tunnel.mode.xtcp')}</option>
              </select>
            )}
          </Field>
          {/* The two ports are different fields: each has its own key, so switching modes does not carry "blurred" over to the other. */}
          {draft.mode === 'public' ? (
            <Field key="remote" id="frp-remote" label={t('multiplayer.tunnel.remotePort')} error={tunnelPortIssue ? t(tunnelPortIssue.key) : null}>
              {(control) => <NumberInput {...control} value={draft.remotePort} disabled={busy} onChange={(text) => setDraft({ ...draft, remotePort: text })} />}
            </Field>
          ) : (
            <Field key="visitor" id="frp-visitor" label={t('multiplayer.tunnel.visitorPort')} error={tunnelPortIssue ? t(tunnelPortIssue.key) : null}>
              {(control) => <NumberInput {...control} value={draft.visitorBindPort} disabled={busy} onChange={(text) => setDraft({ ...draft, visitorBindPort: text })} />}
            </Field>
          )}
        </div>
        <div className="instance-actions">
          <button className={!configured && installed ? 'btn btn-primary' : 'btn'} type="submit" disabled={busy || tunnelBlocker !== null}>
            {t(!configured && installed ? 'multiplayer.tunnel.saveOpen' : 'multiplayer.tunnel.save')}
          </button>
          {blockerHint(tunnelBlocker, tunnelFeedback, tunnelFormRef)}
        </div>
      </form>
    </FormFeedbackProvider>
  );

  const endpointForm = (
    <FormFeedbackProvider value={endpointFeedback.value}>
      <form
        ref={endpointFormRef}
        className="card form-card"
        noValidate
        onSubmit={(event: FormEvent) => { event.preventDefault(); submitEndpoint(); }}
        onKeyDown={(event) => submitOnEnter(event, submitEndpoint)}
      >
        <div className="grid grid-2">
          <Field id="frp-name" label={t('multiplayer.endpoint.name')}>
            {(control) => <input {...control} value={endpointDraft.name} maxLength={64} disabled={busy} onChange={(event) => setEndpointDraft({ ...endpointDraft, name: event.target.value })} />}
          </Field>
          <Field
            id="frp-visit"
            label={t('multiplayer.endpoint.visitHost')}
            optional
            help={t('multiplayer.endpoint.visitHostHelp')}
            error={endpointIssues.visitHost ? t(endpointIssues.visitHost.key) : null}
          >
            {(control) => <input {...control} value={endpointDraft.visitHost} disabled={busy} onChange={(event) => setEndpointDraft({ ...endpointDraft, visitHost: event.target.value })} />}
          </Field>
        </div>
        <div className="grid grid-2">
          <Field id="frp-address" label={t('multiplayer.endpoint.address')} error={endpointIssues.address ? t(endpointIssues.address.key) : null}>
            {(control) => <input {...control} value={endpointDraft.serverAddr} disabled={busy} onChange={(event) => setEndpointDraft({ ...endpointDraft, serverAddr: event.target.value })} />}
          </Field>
          <Field id="frp-port" label={t('multiplayer.endpoint.port')} error={endpointIssues.port ? t(endpointIssues.port.key) : null}>
            {(control) => <NumberInput {...control} value={endpointDraft.serverPort} disabled={busy} onChange={(text) => setEndpointDraft({ ...endpointDraft, serverPort: text })} />}
          </Field>
        </div>
        <div className="grid grid-2">
          <Field id="frp-transport" label={t('multiplayer.endpoint.transport')}>
            {(control) => (
              <select {...control} value={endpointDraft.transport} disabled={busy} onChange={(event) => setEndpointDraft({ ...endpointDraft, transport: event.target.value as EndpointDraft['transport'] })}>
                {FRP_TRANSPORTS.map((transport) => <option key={transport} value={transport}>{transport}</option>)}
              </select>
            )}
          </Field>
          <Field id="frp-token" label={t('multiplayer.endpoint.token')} error={endpointIssues.token ? t(endpointIssues.token.key) : null}>
            {(control) => <PasswordInput {...control} autoComplete="off" value={endpointDraft.token} disabled={busy} onChange={(event) => setEndpointDraft({ ...endpointDraft, token: event.target.value })} />}
          </Field>
        </div>
        <label className="checkbox-field">
          <input type="checkbox" checked={endpointDraft.tls} disabled={busy} onChange={(event) => setEndpointDraft({ ...endpointDraft, tls: event.target.checked })} />
          <span>{t('multiplayer.endpoint.tls')}</span>
        </label>
        <div className="instance-actions">
          <button className={serverIsNext ? 'btn btn-primary' : 'btn'} type="submit" disabled={busy || endpointBlocker !== null}>
            {t('multiplayer.endpoint.save')}
          </button>
          {/* A dialog-style form has no action bar: when the primary button is disabled, the text beside the button says which item to fill in or fix first. */}
          {blockerHint(endpointBlocker, endpointFeedback, endpointFormRef)}
          {hasEndpoints && (
            <button className="btn btn-plain" type="button" disabled={busy} onClick={() => { setAdding(false); setEndpointDraft(EMPTY_ENDPOINT); endpointFeedback.reset(); }}>
              {t('action.cancel')}
            </button>
          )}
        </div>
      </form>
    </FormFeedbackProvider>
  );

  const endpointSection = (
    <section className="form-section">
      <h3 className="form-section-title">{t(hasEndpoints ? 'multiplayer.endpoint.add' : 'multiplayer.section.server')}</h3>
      {showEndpointForm ? endpointForm : (
        <div className="card form-card">
          <div className="instance-actions">
            <button className="btn" type="button" disabled={busy} onClick={() => setAdding(true)}>
              <Plus size={15} aria-hidden="true" />
              {t('multiplayer.endpoint.add')}
            </button>
          </div>
        </div>
      )}
    </section>
  );

  return (
    <MultiplayerLayout guide={guideContent} control={guide}>
      <p className="section-lead">{t('multiplayer.intro')}</p>
      {error && <p className="callout callout-danger" role="alert">{error}</p>}
      {notice && <p className="callout" role="status">{notice}</p>}
      {runtime && !runtime.platformSupported && (
        <p className="callout callout-danger" role="alert">{t('multiplayer.runtime.unsupported')}</p>
      )}
      {runtime?.platformSupported && !runtime.installed && (
        <RuntimeInstallCallout
          missing={t('multiplayer.runtime.missing')}
          installLabel={t('multiplayer.runtime.install')}
          archive={runtime.archive}
          busy={busy}
          uploading={uploading}
          onInstall={() => void install()}
          onUpload={upload}
        />
      )}
      {loading && <p className="field-help" role="status">{t('common.loading')}</p>}

      {/* When the very first read fails it is unknown whether there are servers: the add form is not drawn (it would be taken as "none has ever been configured"), and only retry is offered. */}
      {tunnel === null && error && (
        <div className="instance-actions">
          <button className="btn" type="button" onClick={() => void refresh()}>{t('action.retry')}</button>
        </div>
      )}

      {!loading && tunnel !== null && !hasEndpoints && endpointSection}

      {hasEndpoints && tunnel && configured && (installed || tunnel.enabled) && (
        <OpenSwitch
          checked={tunnel.enabled}
          disabled={busy}
          status={tunnel.status !== 'disabled' && <StatusPill tone={statusTone(tunnel.status)}>{t(STATUS_KEY[tunnel.status])}</StatusPill>}
          onChange={(next) => void toggleTunnel(next)}
        />
      )}
      {hasEndpoints && tunnel?.detail && <p className="callout" role="status">{tm(tunnel.detail)}</p>}

      {hasEndpoints && tunnel?.enabled && joinSteps && <JoinSteps steps={joinSteps} />}

      {/* The first time: tunnel settings are the main task of this screen and are expanded directly; once saved they are tucked into the collapsible section, with add server inside too. */}
      {hasEndpoints && !configured && (
        <section className="form-section">
          <h3 className="form-section-title">{t('multiplayer.section.access')}</h3>
          {tunnelForm('card form-card')}
        </section>
      )}
      {hasEndpoints && !configured && endpointSection}
      {hasEndpoints && configured && (
        <details className="disclosure multiplayer-settings" open={settingsOpen ?? false} onToggle={(event) => setSettingsOpen(event.currentTarget.open)}>
          <summary>{t('multiplayer.section.access')}</summary>
          {tunnelForm('multiplayer-settings-form')}
          {/* Adding a server and the save above are two separate things, so it is its own group with its own heading once expanded; it is another form and cannot be nested in the one above. */}
          <div className="multiplayer-add">
            {showEndpointForm ? (
              <section className="form-section">
                <h3 className="form-section-title">{t('multiplayer.endpoint.add')}</h3>
                {endpointForm}
              </section>
            ) : (
              <div className="instance-actions">
                <button className="btn" type="button" disabled={busy} onClick={() => setAdding(true)}>
                  <Plus size={15} aria-hidden="true" />
                  {t('multiplayer.endpoint.add')}
                </button>
              </div>
            )}
          </div>
        </details>
      )}

      {installed && runtime && (
        <div className="instance-meta multiplayer-meta">
          <span>{t('multiplayer.runtime.installed', { version: runtime.version })}</span>
        </div>
      )}

      <ConfirmDialog
        open={confirmDelete}
        title={t('multiplayer.endpoint.deleteTitle')}
        description={t('multiplayer.endpoint.deleteBody')}
        confirmLabel={t('multiplayer.endpoint.delete')}
        danger
        busy={busy}
        onConfirm={() => void removeEndpoint()}
        onCancel={() => setConfirmDelete(false)}
      />
    </MultiplayerLayout>
  );
}
