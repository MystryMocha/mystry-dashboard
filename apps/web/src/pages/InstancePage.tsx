import { useCallback, useState } from 'react';
import { Link, NavLink, Route, Routes, useParams } from 'react-router-dom';
import {
  ArrowLeft,
  Folder,
  Play,
  Power,
  RotateCcw,
  Settings,
  Sliders,
  Terminal,
} from 'lucide-react';
import type { InstanceInfo } from '@mystry/shared';
import { api, controlInstance, instanceApi, type InstanceAction } from '../api';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { ConfigTab } from '../components/ConfigTab';
import { ConsolePanel } from '../components/ConsolePanel';
import { EulaCheckbox } from '../components/EulaCheckbox';
import { FilesTab } from '../components/FilesTab';
import { JavaRuntimeSelect } from '../components/JavaRuntimeSelect';
import { JvmSettingsEditor } from '../components/JvmSettingsEditor';
import { UnsavedChangesDialog } from '../components/UnsavedChangesDialog';
import { errorMessage } from '../errors';
import { useInstanceAction } from '../hooks/useInstanceAction';
import { usePolling } from '../hooks/usePolling';
import { useUnsavedGuard } from '../hooks/useUnsavedGuard';
import {
  canStartInstance,
  canStopInstance,
  instanceStatusLabel,
  isLifecycleBusy,
  isProcessAlive,
} from '../instance-status';

function ConsoleTab({ instance }: { instance: InstanceInfo }) {
  return (
    <div>
      <ConsolePanel instanceId={instance.id} canSend={instance.status === 'running'} />
    </div>
  );
}

function MigrationPanel({ instance, onAdopt }: { instance: InstanceInfo; onAdopt: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function adopt() {
    setBusy(true); setError('');
    try { await api(instanceApi(instance.id, '/adopt-managed-directory'), { method: 'POST' }); await onAdopt(); }
    catch (err) { setError(errorMessage(err)); }
    finally { setBusy(false); }
  }
  return <div className="migration-panel"><span className="badge migration">需要迁移</span><h2>接管托管目录</h2>
    <p>请使用系统文件管理器，将旧实例文件复制到面板数据目录下的实例文件夹：</p><code>面板数据目录/instances/{instance.id}</code>
    <p className="muted">面板不会读取或删除旧目录。复制完成后点击「接管托管目录」，成功后将恢复实例操作。</p>{error && <p className="error">{error}</p>}
    <button className="btn" type="button" disabled={busy} onClick={() => void adopt()}>{busy ? '检查中…' : '接管托管目录'}</button>
  </div>;
}

type SettingsDraft = Pick<InstanceInfo, 'name' | 'jarFile' | 'jvmArgs' | 'acceptEula' | 'javaRuntimeId'>;

function settingsFromInstance(instance: InstanceInfo): SettingsDraft {
  return {
    name: instance.name,
    jarFile: instance.jarFile,
    jvmArgs: instance.jvmArgs,
    acceptEula: instance.acceptEula,
    javaRuntimeId: instance.javaRuntimeId,
  };
}

function isSameSettings(left: SettingsDraft, right: SettingsDraft): boolean {
  return left.name === right.name
    && left.jarFile === right.jarFile
    && left.jvmArgs === right.jvmArgs
    && left.acceptEula === right.acceptEula
    && left.javaRuntimeId === right.javaRuntimeId;
}

function SettingsTab({
  instance,
  onSaved,
}: {
  instance: InstanceInfo;
  onSaved: () => void;
}) {
  const [name, setName] = useState(instance.name);
  const [jarFile, setJarFile] = useState(instance.jarFile);
  const [jvmArgs, setJvmArgs] = useState(instance.jvmArgs);
  const [acceptEula, setAcceptEula] = useState(instance.acceptEula);
  const [javaRuntimeId, setJavaRuntimeId] = useState<string | null>(instance.javaRuntimeId);
  const [javaMajor, setJavaMajor] = useState<number | null>(null);
  const [jvmValid, setJvmValid] = useState(true);
  const [originalSettings, setOriginalSettings] = useState<SettingsDraft>(() => settingsFromInstance(instance));
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const draft: SettingsDraft = { name, jarFile, jvmArgs, acceptEula, javaRuntimeId };
  const dirty = !isSameSettings(draft, originalSettings);
  const blocker = useUnsavedGuard(dirty, saving);

  async function save() {
    if (!dirty || saving || !jvmValid) return;
    setSaving(true);
    setSaved(false);
    try {
      await api(instanceApi(instance.id), {
        method: 'PATCH',
        json: draft,
      });
      setError('');
      setOriginalSettings(draft);
      setSaved(true);
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="panel" style={{ maxWidth: 640 }}>
      {error && <p className="error">{error}</p>}
      {dirty && <p className="muted" role="status">有未保存的设置。</p>}
      {saved && !dirty && <p className="muted" role="status" aria-live="polite">设置已保存。</p>}
      <div className="field">
        <label htmlFor="instance-settings-name">名称</label>
        <input
          id="instance-settings-name"
          value={name}
          disabled={saving}
          onChange={(e) => {
            setName(e.target.value);
            setSaved(false);
          }}
        />
      </div>
      <div className="field">
        <label htmlFor="instance-settings-jar-file">Jar 文件名</label>
        <input
          id="instance-settings-jar-file"
          value={jarFile}
          disabled={saving}
          onChange={(e) => {
            setJarFile(e.target.value);
            setSaved(false);
          }}
        />
      </div>
      <div className="field">
        <label htmlFor="instance-settings-install-path">安装路径</label>
        <input
          id="instance-settings-install-path"
          value={instance.installPath ?? `面板数据目录/instances/${instance.id}`}
          readOnly
        />
        <p className="muted" style={{ margin: '0.25rem 0 0', fontSize: '0.8rem' }}>
          实例目录由面板托管，创建后不可修改。
        </p>
      </div>
      <JavaRuntimeSelect
        value={javaRuntimeId}
        onChange={(nextRuntimeId) => {
          setJavaRuntimeId(nextRuntimeId);
          setSaved(false);
        }}
        mcVersion={instance.mcVersion}
        disabled={saving}
        onResolvedMajorChange={setJavaMajor}
      />
      <JvmSettingsEditor
        value={jvmArgs}
        onChange={(next) => {
          setJvmArgs(next);
          setSaved(false);
        }}
        coreType={instance.coreType}
        javaMajor={javaMajor}
        disabled={saving}
        onValidityChange={setJvmValid}
      />
      <EulaCheckbox
        checked={acceptEula}
        disabled={saving}
        onChange={(checked) => {
          setAcceptEula(checked);
          setSaved(false);
        }}
      />
      <button className="btn" type="button" disabled={!dirty || saving || !jvmValid} onClick={() => void save()}>
        {saving ? '保存中…' : '保存设置'}
      </button>

      <UnsavedChangesDialog
        blocker={blocker}
        saving={saving}
        subject="设置"
        description="离开设置页会丢失尚未保存的实例设置。"
      />
    </div>
  );
}

export function InstancePage() {
  const { id = '' } = useParams();
  const [instance, setInstance] = useState<InstanceInfo | null>(null);
  const [loadError, setLoadError] = useState('');
  const [confirmRestart, setConfirmRestart] = useState(false);
  const [confirmForceStop, setConfirmForceStop] = useState(false);

  const load = useCallback(async () => {
    try {
      setInstance(await api<InstanceInfo>(instanceApi(id)));
      setLoadError('');
    } catch (err) {
      setLoadError(errorMessage(err));
    }
  }, [id]);
  usePolling(load);

  const { busyId, error: actionError, run } = useInstanceAction(load);
  const busy = busyId !== null;
  const error = actionError || loadError;

  function act(action: InstanceAction, options?: { force?: boolean }) {
    void run(id, () => controlInstance(id, action, options));
  }

  if (!instance) {
    return <p>{error || '加载中…'}</p>;
  }

  return (
    <div className="instance-page" style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
        <div className="instance-hub-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: '14px', flexWrap: 'wrap' }}>
            <Link to="/" className="btn btn-icon" title="返回总览">
              <ArrowLeft size={18} />
            </Link>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <h2 style={{ fontSize: '1.25rem', margin: 0, fontWeight: 700 }}>{instance.name}</h2>
                <span className={`status-badge ${instance.requiresMigration ? 'starting' : instance.status}`}>
                  {instance.requiresMigration ? '待迁移' : `● ${instanceStatusLabel[instance.status] || instance.status}`}
                </span>
              </div>
              <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                核心：{instance.coreType.toUpperCase()} {instance.mcVersion ? `· 版本 ${instance.mcVersion}` : ''}
              </span>
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
            {canStartInstance(instance.status) && (
              <button
                className="btn btn-ok"
                type="button"
                disabled={busy || instance.requiresMigration}
                onClick={() => act('start')}
              >
                <Play size={14} />
                启动
              </button>
            )}
            {canStopInstance(instance.status) && (
              <button
                className="btn btn-danger"
                type="button"
                disabled={busy || instance.requiresMigration}
                onClick={() => act('stop')}
              >
                <Power size={14} />
                停止
              </button>
            )}
            <button
              className="btn"
              type="button"
              disabled={busy || instance.requiresMigration || isLifecycleBusy(instance.status)}
              onClick={() => setConfirmRestart(true)}
            >
              <RotateCcw size={14} />
              重启
            </button>
            <button
              className="btn btn-ghost"
              type="button"
              disabled={busy || instance.requiresMigration || !isProcessAlive(instance.status)}
              onClick={() => setConfirmForceStop(true)}
            >
              强制停止
            </button>
          </div>
        </div>

        {error && <p className="error" role="alert">{error}</p>}

        {!instance.requiresMigration && (
          <div className="hub-tabs">
            <NavLink
              to={`/instances/${id}`}
              end
              className={({ isActive }) => `hub-tab${isActive ? ' active' : ''}`}
            >
              <Terminal size={15} />
              <span>控制台</span>
            </NavLink>
            <NavLink
              to={`/instances/${id}/files`}
              className={({ isActive }) => `hub-tab${isActive ? ' active' : ''}`}
            >
              <Folder size={15} />
              <span>文件管理</span>
            </NavLink>
            <NavLink
              to={`/instances/${id}/config`}
              className={({ isActive }) => `hub-tab${isActive ? ' active' : ''}`}
            >
              <Sliders size={15} />
              <span>参数配置</span>
            </NavLink>
            <NavLink
              to={`/instances/${id}/settings`}
              className={({ isActive }) => `hub-tab${isActive ? ' active' : ''}`}
            >
              <Settings size={15} />
              <span>实例设置 & JVM</span>
            </NavLink>
          </div>
        )}
      </div>

      <div className="instance-body" key={instance.id}>
        {instance.requiresMigration ? (
          <MigrationPanel instance={instance} onAdopt={load} />
        ) : (
          <Routes>
            <Route index element={<ConsoleTab instance={instance} />} />
            <Route path="files" element={<FilesTab instanceId={instance.id} />} />
            <Route path="config" element={<ConfigTab instanceId={instance.id} />} />
            <Route path="settings" element={<SettingsTab instance={instance} onSaved={load} />} />
          </Routes>
        )}
      </div>

      <ConfirmDialog
        open={confirmRestart}
        title={`重启实例「${instance.name}」？`}
        description="重启会中断当前游戏进程并断开所有在线玩家，未保存的世界数据可能丢失。"
        confirmLabel="确认重启"
        busy={busy}
        onConfirm={() => {
          setConfirmRestart(false);
          act('restart');
        }}
        onCancel={() => setConfirmRestart(false)}
      />
      <ConfirmDialog
        open={confirmForceStop}
        title={`强制停止实例「${instance.name}」？`}
        description="强制停止会立即强制结束进程，可能导致世界损坏。建议先尝试普通「停止」。"
        confirmLabel="确认强制停止"
        danger
        busy={busy}
        onConfirm={() => {
          setConfirmForceStop(false);
          act('stop', { force: true });
        }}
        onCancel={() => setConfirmForceStop(false)}
      />
    </div>
  );
}
