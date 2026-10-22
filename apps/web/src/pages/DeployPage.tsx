import { useEffect, useId, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Check } from 'lucide-react';
import type { TaskInfo } from '@mystry/shared';
import { api, pollTask } from '../api';
import { CoreIcon } from '../components/CoreIcon';
import { EulaCheckbox } from '../components/EulaCheckbox';
import { ErrorSummary } from '../components/ErrorSummary';
import { LazyScrollSelect } from '../components/LazyScrollSelect';
import { JavaRuntimeSelect } from '../components/JavaRuntimeSelect';
import { JvmSettingsEditor } from '../components/JvmSettingsEditor';
import { PageHeader } from '../components/PageHeader';
import { TaskProgress } from '../components/TaskProgress';
import { errorMessage, isAbortError } from '../errors';
import { useKeyedLoader } from '../hooks/useKeyedLoader';

type CoreType = 'paper' | 'fabric' | 'vanilla' | 'forge' | 'neoforge';

const CORE_ITEMS: Array<{ id: CoreType; name: string; desc: string }> = [
  { id: 'paper', name: 'Paper', desc: '插件服 · 新手推荐' },
  { id: 'fabric', name: 'Fabric', desc: '轻量现代化模组' },
  { id: 'forge', name: 'Forge', desc: '经典重型模组' },
  { id: 'neoforge', name: 'NeoForge', desc: '新一代模组端' },
  { id: 'vanilla', name: 'Vanilla', desc: 'Mojang 原版' },
];

function hasLoader(coreType: CoreType | ''): coreType is 'fabric' | 'forge' | 'neoforge' {
  return coreType === 'fabric' || coreType === 'forge' || coreType === 'neoforge';
}

export function DeployPage() {
  const navigate = useNavigate();
  // 默认选中新手推荐的 Paper，进入页面即可直接部署最新正式版。
  const [coreType, setCoreType] = useState<CoreType | ''>('paper');
  const [mcVersion, setMcVersion] = useState('');
  const [build, setBuild] = useState<number | ''>('');
  const [loaderVersion, setLoaderVersion] = useState('');
  const [installerVersion, setInstallerVersion] = useState('');
  const [name, setName] = useState('我的服务器');
  const [jvmArgs, setJvmArgs] = useState('-Xms1G -Xmx2G');
  const [javaRuntimeId, setJavaRuntimeId] = useState<string | null>(null);
  const [javaMajor, setJavaMajor] = useState<number | null>(null);
  const [jvmValid, setJvmValid] = useState(true);
  // EULA 必须由用户主动勾选同意，不预先替用户同意。
  const [acceptEula, setAcceptEula] = useState(false);
  const [error, setError] = useState('');
  const [progress, setProgress] = useState<TaskInfo | null>(null);
  const [busy, setBusy] = useState(false);
  /** 组件卸载时中止进行中的任务轮询，避免登出/离开页面后仍持续请求或跳转。 */
  const pollAbortRef = useRef<AbortController | null>(null);
  const coreOptionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const nameFieldId = useId();

  // 元数据按「核心 / 核心 + 版本」缓存，切换后旧列表立即失效，迟到的旧响应被丢弃。
  const versions = useKeyedLoader(coreType || null, async () =>
    (await api<{ versions: string[] }>(`/api/cores/${coreType}/versions`)).versions);
  // 服务端按新到旧返回正式版，未手动选择时默认用最新版本。
  const selectedMcVersion = mcVersion || versions.data?.[0] || '';
  const encodedMcVersion = encodeURIComponent(selectedMcVersion);
  const builds = useKeyedLoader(
    coreType === 'paper' && selectedMcVersion ? `paper:${selectedMcVersion}` : null,
    async () => (await api<{ builds: number[] }>(`/api/cores/paper/${encodedMcVersion}/builds`)).builds,
  );
  // Fabric 的 Installer 与 Loader 来自同一个接口。
  const loaders = useKeyedLoader(
    hasLoader(coreType) && selectedMcVersion ? `${coreType}:${selectedMcVersion}` : null,
    () => api<{ loaders: string[]; installers?: string[] }>(`/api/cores/${coreType}/${encodedMcVersion}/loaders`),
  );
  const metadataError = versions.error || builds.error || loaders.error;
  const loadVersions = versions.load;

  useEffect(() => {
    return () => pollAbortRef.current?.abort();
  }, []);

  // 选定核心后立即拉取版本列表，不必等用户展开下拉框。
  useEffect(() => {
    void loadVersions();
  }, [coreType, loadVersions]);

  function handleMcVersionChange(next: string) {
    setMcVersion(next);
    setBuild('');
    setLoaderVersion('');
    setInstallerVersion('');
  }

  function handleCoreTypeChange(next: CoreType | '') {
    if (next === coreType) return;
    setCoreType(next);
    setError('');
    handleMcVersionChange('');
  }

  /** 单选组键盘行为：方向键移动并选中，焦点跟随。 */
  function onCoreKeyDown(event: React.KeyboardEvent<HTMLButtonElement>, index: number) {
    if (busy) return;
    const delta = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1
      : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1
        : 0;
    if (delta === 0) return;
    event.preventDefault();
    const next = (index + delta + CORE_ITEMS.length) % CORE_ITEMS.length;
    handleCoreTypeChange(CORE_ITEMS[next]!.id);
    coreOptionRefs.current[next]?.focus();
  }

  async function deploy() {
    if (!coreType || !selectedMcVersion) return;
    if (!jvmValid) {
      setError('请先修正 JVM 参数错误');
      return;
    }
    setBusy(true);
    setError('');
    setProgress(null);
    // 先建控制器并保存：POST 期间卸载也能立即中止，避免之后无人接管轮询。
    const controller = new AbortController();
    pollAbortRef.current = controller;
    try {
      const task = await api<TaskInfo>('/api/cores/deploy', {
        method: 'POST',
        signal: controller.signal,
        json: {
          name,
          coreType,
          mcVersion: selectedMcVersion,
          build: build === '' ? undefined : Number(build),
          loaderVersion: loaderVersion || undefined,
          installerVersion: installerVersion || undefined,
          jvmArgs,
          acceptEula,
          javaRuntimeId,
        },
      });
      if (controller.signal.aborted) return;
      setProgress(task);
      const result = await pollTask(task.id, setProgress, controller.signal);
      if (result?.instanceId) navigate(`/instances/${result.instanceId}`);
    } catch (err) {
      // 组件卸载导致的中止不是错误，不需要提示。
      if (isAbortError(err)) return;
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const loaderLabel =
    coreType === 'forge' ? 'Forge 版本' : coreType === 'neoforge' ? 'NeoForge 版本' : 'Loader 版本';

  // Build、Loader 与 Installer 留空时由服务端解析为最新稳定版，只有核心与游戏版本必填。
  const canDeploy = Boolean(coreType && selectedMcVersion) && acceptEula;
  const selectedCore = CORE_ITEMS.find((item) => item.id === coreType);

  return (
    <div className="page">
      <PageHeader
        title="一键部署"
        subtitle="从官方源下载服务端核心，自动完成安装与启动配置。"
      />

      <div className="deploy-layout">
        <div className="form-stack">
          <section className="form-section" aria-labelledby={`${nameFieldId}-core-title`}>
            <h2 className="form-section-title" id={`${nameFieldId}-core-title`}>
              <span className="step-badge" aria-hidden="true">1</span>
              选择服务端核心
            </h2>
            <div className="core-select-grid" role="radiogroup" aria-labelledby={`${nameFieldId}-core-title`}>
              {CORE_ITEMS.map((item, index) => {
                const selected = coreType === item.id;
                return (
                  <button
                    key={item.id}
                    ref={(el) => { coreOptionRefs.current[index] = el; }}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    tabIndex={selected || (!coreType && index === 0) ? 0 : -1}
                    disabled={busy}
                    className={`core-option${selected ? ' selected' : ''}`}
                    onClick={() => handleCoreTypeChange(item.id)}
                    onKeyDown={(event) => onCoreKeyDown(event, index)}
                  >
                    <CoreIcon coreType={item.id} />
                    <span className="core-name">{item.name}</span>
                    <span className="core-desc">{item.desc}</span>
                    <span className="core-check" aria-hidden="true"><Check size={12} strokeWidth={3} /></span>
                  </button>
                );
              })}
            </div>
          </section>

          <section className="form-section">
            <h2 className="form-section-title">
              <span className="step-badge" aria-hidden="true">2</span>
              基本信息
            </h2>
            <div className="card form-card">
              <div className="field">
                <label htmlFor={nameFieldId}>实例名称</label>
                <input
                  id={nameFieldId}
                  value={name}
                  disabled={busy}
                  onChange={(e) => setName(e.target.value)}
                />
              </div>

              <div className="field">
                <label id={`${nameFieldId}-mc-version-label`}>游戏版本</label>
                <LazyScrollSelect
                  ariaLabel="游戏版本"
                  value={selectedMcVersion}
                  options={versions.data ?? []}
                  onChange={handleMcVersionChange}
                  onOpen={() => void loadVersions()}
                  loading={versions.loading}
                  disabled={busy || !coreType}
                  placeholder={
                    !coreType ? '请先选择上方核心' : versions.loading ? '正在获取版本列表…' : '请选择游戏版本'
                  }
                  emptyText="暂无可用版本"
                />
              </div>
              {coreType === 'paper' && (
                <div className="field">
                  <label id={`${nameFieldId}-paper-build-label`}>Paper 构建版本（可选）</label>
                  <LazyScrollSelect
                    ariaLabel="Paper Build"
                    value={build}
                    options={builds.data ?? []}
                    onChange={setBuild}
                    onOpen={() => void builds.load()}
                    loading={builds.loading}
                    formatLabel={(b) => `#${b}`}
                    disabled={busy || !selectedMcVersion}
                    placeholder="自动使用最新构建（优先稳定版）"
                    emptyText="暂无 Build"
                  />
                </div>
              )}
              {hasLoader(coreType) && (
                <div className="field">
                  <label id={`${nameFieldId}-loader-label`}>{loaderLabel}（可选）</label>
                  <LazyScrollSelect
                    ariaLabel={loaderLabel}
                    value={loaderVersion}
                    options={loaders.data?.loaders ?? []}
                    onChange={setLoaderVersion}
                    onOpen={() => void loaders.load()}
                    loading={loaders.loading}
                    disabled={busy || !selectedMcVersion}
                    placeholder="自动使用最新稳定版"
                    emptyText="暂无版本"
                  />
                </div>
              )}
              {coreType === 'fabric' && (
                <div className="field">
                  <label id={`${nameFieldId}-installer-label`}>Installer 版本（可选）</label>
                  <LazyScrollSelect
                    ariaLabel="Fabric Installer 版本"
                    value={installerVersion}
                    options={loaders.data?.installers ?? []}
                    onChange={setInstallerVersion}
                    onOpen={() => void loaders.load()}
                    loading={loaders.loading}
                    disabled={busy || !selectedMcVersion}
                    placeholder="自动使用最新稳定版"
                    emptyText="暂无版本"
                  />
                </div>
              )}
              {(coreType === 'forge' || coreType === 'neoforge') && (
                <p className="field-help">
                  Forge / NeoForge 需要先下载官方安装器并完成安装，耗时会比其他核心长一些。
                </p>
              )}
              {metadataError && <p className="error" role="alert">无法获取版本信息：{metadataError}</p>}
            </div>
          </section>

          <section className="form-section">
            <h2 className="form-section-title">
              <span className="step-badge" aria-hidden="true">3</span>
              运行环境
            </h2>
            <div className="card form-card">
              <JavaRuntimeSelect
                value={javaRuntimeId}
                onChange={setJavaRuntimeId}
                mcVersion={selectedMcVersion || null}
                disabled={busy}
                onResolvedMajorChange={setJavaMajor}
              />
              <JvmSettingsEditor
                value={jvmArgs}
                onChange={setJvmArgs}
                coreType={coreType || 'custom'}
                javaMajor={javaMajor}
                disabled={busy}
                useRecommendedDefault
                onValidityChange={setJvmValid}
              />
            </div>
          </section>

          <section className="form-section">
            <h2 className="form-section-title">
              <span className="step-badge" aria-hidden="true">4</span>
              确认并部署
            </h2>
            <div className="card form-card">
              <EulaCheckbox checked={acceptEula} disabled={busy} onChange={setAcceptEula} />
              {!acceptEula && (
                <p className="field-help">
                  Minecraft 服务器必须同意 EULA 才能运行，勾选后才能开始部署。
                </p>
              )}
              {progress && <TaskProgress task={progress} label="部署进度" />}
              {busy && (
                <p className="field-help" role="status" aria-live="polite">
                  部署任务已提交，可以离开此页，进度会在右上角「任务中心」持续更新。
                </p>
              )}
              {error && <ErrorSummary key={error} title="部署失败" detailTitle="部署错误详情" error={error} />}
            </div>
          </section>

          <div className="action-bar">
            <span className="action-bar-status">
              {selectedCore ? `${selectedCore.name}${selectedMcVersion ? ` ${selectedMcVersion}` : ''}` : '尚未选择核心'}
              {name ? ` · ${name}` : ''}
            </span>
            <button
              className="btn btn-primary"
              type="button"
              disabled={busy || !canDeploy || !jvmValid}
              onClick={() => void deploy()}
            >
              {busy ? '部署任务运行中…' : '开始部署'}
            </button>
          </div>
        </div>

        {/* 右侧新手指引：怎么选核心、部署后怎么进服 */}
        <aside className="card deploy-guide" aria-label="新手指引">
          <h3>选哪个核心？</h3>
          <ul>
            <li><strong>Paper</strong>：想装插件（领地、经济等）选它，性能也更好。</li>
            <li><strong>Fabric / NeoForge / Forge</strong>：想装模组时，按模组页面要求的加载器选择。</li>
            <li><strong>Vanilla</strong>：纯原版，不装插件和模组。</li>
          </ul>
          <h3>部署完成后</h3>
          <ol>
            <li>在实例页点「启动」，等控制台出现 <code>Done</code>。</li>
            <li>同一台电脑的游戏里添加服务器地址 <code>127.0.0.1</code>。</li>
            <li>朋友加入需要你的局域网或公网地址，并放行防火墙端口（默认 25565）。</li>
          </ol>
        </aside>
      </div>
    </div>
  );
}
