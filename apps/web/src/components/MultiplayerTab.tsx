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

/** 主按钮不可点的原因：第一个要改或要填的字段。 */
interface Blocker {
  id: string;
  label: string;
  /** fix：填了但不合规；fill：必填项还空着。 */
  kind: 'fix' | 'fill';
}

/** 先找填错的（和 focusFirstInvalidField 找到的是同一个），没有再找空着的必填项。checks 按页面上字段的先后排。 */
function firstBlocker(checks: { id: string; label: string; invalid: boolean; empty: boolean }[]): Blocker | null {
  const invalid = checks.find((check) => check.invalid);
  if (invalid) return { id: invalid.id, label: invalid.label, kind: 'fix' };
  const empty = checks.find((check) => check.empty);
  return empty ? { id: empty.id, label: empty.label, kind: 'fill' } : null;
}

/**
 * 在输入框里按 Enter 等同于点主按钮。主按钮禁用时浏览器不会触发 submit，所以表单自己接；
 * 只管输入框，不拦按钮和下拉框，输入法选词时的 Enter 也不算。
 */
function submitOnEnter(event: KeyboardEvent<HTMLFormElement>, submit: () => void): void {
  // Safari 确认候选词的那次 Enter 不带 isComposing，只能靠 keyCode 229 认出来。
  if (event.key !== 'Enter' || event.nativeEvent.isComposing || event.keyCode === 229) return;
  if (!(event.target instanceof HTMLInputElement)) return;
  // 勾选框上的 Enter 不算提交。
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
 * 实例 frp 穿透：只配置官方 frpc，不提供原始配置或可执行路径。
 * 还没有 frp 服务器时先显示添加表单；有了以后按「开关 → 让玩家加入 → 穿透设置 → 添加服务器」排。
 * 第一次要先选好服务器和穿透模式并保存，开关才能用，免得用没看过的默认值在 frp 服务器上开端口。
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
  // 复制加入说明 / 玩家配置的结果显示在按钮下面。
  const [copied, showCopied] = useFlash();
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [adding, setAdding] = useState(false);
  // 穿透设置折叠区：第一次读到时，已经开放就收起，没开放就展开。
  const [settingsOpen, setSettingsOpen] = useState<boolean | null>(null);
  useEffect(() => {
    if (tunnel && settingsOpen === null) setSettingsOpen(!tunnel.enabled);
  }, [tunnel, settingsOpen]);
  // 两张表单各有一份「错误显没显示」的状态，互不影响。
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

  // 添加 frp 服务器：名称、地址、端口、令牌必填，端口和地址格式与服务端一致。
  // 空的必填项不算填错（不标红），只让主按钮不可点，并在按钮旁说出要填哪一项。
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
  // 穿透设置只校验当前模式用到的那个端口；另一个端口的输入框不在页面上，它的草稿不参与校验也不提交。
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

  /** 提交不了时：让所有字段显示原因，并跳到第一个要改的；没有填错、只是空着时跳到第一个要填的。 */
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
      // 还有别的服务器时改选第一个：下拉框本来就会显示它，值留空的话看着选了却保存不了。
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
      // 用服务端已保存的穿透设置开关，不带上下面表单里还没保存的改动。
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
    // 第一次保存（还没选定过服务器）就是「保存并开放」：用户已经看过表单里的端口和模式，不用再回顶部开开关。
    const openNow = !tunnel.endpointId && Boolean(runtime?.installed);
    const remotePort = Number(draft.remotePort);
    // 公网端口模式下「玩家本机端口」的输入框不在页面上：沿用服务端已保存的值，不提交看不见的草稿。
    // 不能省略这个字段，服务端会把省略当成默认值 25565 覆盖掉已保存的端口。
    const visitorBindPort = draft.mode === 'public' ? tunnel.visitorBindPort : Number(draft.visitorBindPort);
    setBusy(true);
    setNotice('');
    try {
      // 之后开关单独保存；这里只改穿透设置，开没开沿用服务端当前状态。
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
  // 还没有服务器时直接展开添加表单；已有服务器时收起，点「添加 frp 服务器」才展开。
  const showEndpointForm = !hasEndpoints || adding;
  // 穿透设置还没保存过（没有选定服务器）时不显示开关，保存按钮就是「保存并开放」。
  const configured = Boolean(tunnel?.endpointId);
  // 第一次读取完成前不知道有没有 frp 服务器，两种排列都先不画，免得添加表单闪一下再换成穿透设置。
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

  // 公网端口模式玩家直接连地址，只有一步；STCP / XTCP 要先把玩家配置发过去。
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

  /** 按钮旁的一句话：主按钮不可点时说出先改哪一项，点了就跳过去并显示原因。 */
  function blockerHint(blocker: Blocker | null, feedback: typeof endpointFeedback, form: { current: HTMLFormElement | null }) {
    if (!blocker || busy) return null;
    return (
      <button className="link-button multiplayer-form-hint" type="button" onClick={() => showBlocker(blocker, feedback, form.current)}>
        {t(blocker.kind === 'fix' ? 'multiplayer.form.fix' : 'multiplayer.form.fill', { field: blocker.label })}
      </button>
    );
  }

  // 穿透设置的表单：第一次直接展开在页面上，保存过以后放进折叠区，两处只是外层类名不同。
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
            // 删除的是下拉框里选中的服务器，按钮放在它旁边。
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
          {/* 两个端口是不同的字段：各带 key，切换模式时不把「失焦过」带给另一个。 */}
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
          {/* 对话式表单没有操作栏：主按钮不可点时，在按钮旁说先填或先改哪一项。 */}
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

      {!loading && !hasEndpoints && endpointSection}

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

      {/* 第一次：穿透设置就是这一屏的主任务，直接展开；保存过以后收进折叠区，添加服务器也放在里面。 */}
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
          {/* 添加服务器和上面的保存是两件事，单独成组，展开后有自己的标题；它是另一张表单，不能套在上面那张里。 */}
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
