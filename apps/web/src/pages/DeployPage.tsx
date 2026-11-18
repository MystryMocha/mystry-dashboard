import { useEffect, useId, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Check } from 'lucide-react';
import { recommendedJavaMajor, type TaskInfo } from '@mystry/shared';
import { api, pollTask } from '../api';
import { CoreIcon } from '../components/CoreIcon';
import { DownloadSourceHint } from '../components/DownloadSourceSection';
import { MINECRAFT_EULA_URL } from '../components/EulaCheckbox';
import { ErrorSummary } from '../components/ErrorSummary';
import { LazyScrollSelect } from '../components/LazyScrollSelect';
import { JavaRuntimeSelect, type JavaMatchStatus } from '../components/JavaRuntimeSelect';
import { JvmSettingsEditor } from '../components/JvmSettingsEditor';
import { PageHeader } from '../components/PageHeader';
import { TaskProgress } from '../components/TaskProgress';
import { errorMessage, isAbortError } from '../errors';
import { useKeyedLoader } from '../hooks/useKeyedLoader';
import { useI18n, type MessageKey } from '../i18n';
import { instanceNameIssue, type Issue } from '../validation';

type CoreType = 'paper' | 'fabric' | 'vanilla' | 'forge' | 'neoforge';

const CORE_ITEMS: Array<{ id: CoreType; name: string; descKey: MessageKey }> = [
  { id: 'paper', name: 'Paper', descKey: 'deploy.core.paper.desc' },
  { id: 'fabric', name: 'Fabric', descKey: 'deploy.core.fabric.desc' },
  { id: 'forge', name: 'Forge', descKey: 'deploy.core.forge.desc' },
  { id: 'neoforge', name: 'NeoForge', descKey: 'deploy.core.neoforge.desc' },
  { id: 'vanilla', name: 'Vanilla', descKey: 'deploy.core.vanilla.desc' },
];

function hasLoader(coreType: CoreType | ''): coreType is 'fabric' | 'forge' | 'neoforge' {
  return coreType === 'fabric' || coreType === 'forge' || coreType === 'neoforge';
}

export function DeployPage() {
  const navigate = useNavigate();
  const { t, rich } = useI18n();
  // 默认选中新手推荐的 Paper，进入页面即可直接部署最新正式版。
  const [coreType, setCoreType] = useState<CoreType | ''>('paper');
  const [mcVersion, setMcVersion] = useState('');
  const [build, setBuild] = useState<number | ''>('');
  const [loaderVersion, setLoaderVersion] = useState('');
  const [installerVersion, setInstallerVersion] = useState('');
  // 默认实例名按进入页面时的界面语言生成，之后由用户自行修改。
  const [name, setName] = useState(() => t('deploy.form.name.default'));
  const [jvmArgs, setJvmArgs] = useState('-Xms1G -Xmx2G');
  const [javaRuntimeId, setJavaRuntimeId] = useState<string | null>(null);
  const [javaMajor, setJavaMajor] = useState<number | null>(null);
  const [jvmValid, setJvmValid] = useState(true);
  // EULA 必须由用户主动勾选同意，不预先替用户同意。
  const [acceptEula, setAcceptEula] = useState(false);
  const [error, setError] = useState('');
  const [progress, setProgress] = useState<TaskInfo | null>(null);
  const [busy, setBusy] = useState(false);
  /** Java 一键安装进行中：装完会自动选中新 Java，之前不允许开始部署。 */
  const [javaInstalling, setJavaInstalling] = useState(false);
  /** 实际要用的 Java 不是推荐版本时不能开始部署：新手用错 Java 时服务器起不来，又看不懂报错。 */
  const [javaStatus, setJavaStatus] = useState<JavaMatchStatus>('loading');
  /** 组件卸载时中止进行中的任务轮询，避免登出/离开页面后仍持续请求或跳转。 */
  const pollAbortRef = useRef<AbortController | null>(null);
  const coreOptionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  /** 第 4 节（进度、失败原因、Java 警告）：出现失败原因时滚到可视范围，免得被操作栏挡住。 */
  const confirmRef = useRef<HTMLElement>(null);
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
    if (!coreType || !selectedMcVersion || blocker) return;
    if (!jvmValid) {
      setError(t('deploy.error.jvmInvalid'));
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

  const loaderLabel = t(
    coreType === 'forge' ? 'deploy.form.loader.forge'
      : coreType === 'neoforge' ? 'deploy.form.loader.neoforge'
        : 'deploy.form.loader.default',
  );

  // Build、Loader 与 Installer 留空时由服务端解析为最新稳定版，只有核心与游戏版本必填。
  const nameIssue = instanceNameIssue(name);
  // 按表单从上到下的顺序找第一个还没满足的条件，操作栏直接说缺什么，而不是只把按钮变灰。
  const javaRecommended = recommendedJavaMajor(selectedMcVersion);
  const blocker: Issue | null = !coreType ? { key: 'deploy.action.noCore' }
    : !selectedMcVersion ? { key: 'deploy.action.needVersion' }
      : nameIssue ? nameIssue
        : !jvmValid ? { key: 'validation.jvm.invalid' }
          : javaInstalling ? { key: 'validation.java.installing' }
            : javaStatus === 'loading' ? { key: 'validation.java.checking' }
              : javaStatus === 'mismatch' ? { key: 'validation.java.mismatch', params: { java: javaRecommended ?? '' } }
                : !acceptEula ? { key: 'deploy.action.needEula' }
                  : null;
  const selectedCore = CORE_ITEMS.find((item) => item.id === coreType);
  const showConfirm = (javaStatus === 'mismatch' && !busy) || busy || progress !== null || error !== '';

  // 第 4 节在长页面底部：开始部署和失败时滚到能看见进度或原因的位置（scroll-margin 让开底部操作栏）。
  useEffect(() => {
    if (busy || error) confirmRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [busy, error]);

  return (
    <div className="page">
      <PageHeader
        title={t('nav.deploy')}
        subtitle={t('deploy.page.subtitle')}
      />

      <div className="deploy-layout">
        <div className="form-stack">
          <section className="form-section" aria-labelledby={`${nameFieldId}-core-title`}>
            <h2 className="form-section-title" id={`${nameFieldId}-core-title`}>
              <span className="step-badge" aria-hidden="true">1</span>
              {t('deploy.core.title')}
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
                    <span className="core-desc">{t(item.descKey)}</span>
                    <span className="core-check" aria-hidden="true"><Check size={12} strokeWidth={3} /></span>
                  </button>
                );
              })}
            </div>
          </section>

          <section className="form-section">
            <h2 className="form-section-title">
              <span className="step-badge" aria-hidden="true">2</span>
              {t('deploy.basic.title')}
            </h2>
            <div className="card form-card">
              {/* 名称和游戏版本都短，宽时并排一行。 */}
              <div className="grid grid-2">
                <div className="field">
                  <label htmlFor={nameFieldId}>{t('deploy.form.name.label')}</label>
                  <input
                    id={nameFieldId}
                    value={name}
                    disabled={busy}
                    aria-invalid={nameIssue ? true : undefined}
                    aria-describedby={nameIssue ? `${nameFieldId}-error` : undefined}
                    onChange={(e) => setName(e.target.value)}
                  />
                  {nameIssue && <p className="error" id={`${nameFieldId}-error`}>{t(nameIssue.key, nameIssue.params)}</p>}
                </div>

                <div className="field">
                  <label id={`${nameFieldId}-mc-version-label`}>{t('deploy.form.mcVersion.label')}</label>
                  <LazyScrollSelect
                    labelId={`${nameFieldId}-mc-version-label`}
                    value={selectedMcVersion}
                    options={versions.data ?? []}
                    onChange={handleMcVersionChange}
                    onOpen={() => void loadVersions()}
                    loading={versions.loading}
                    disabled={busy || !coreType}
                    placeholder={
                      !coreType ? t('deploy.form.mcVersion.placeholder.noCore')
                        : versions.loading ? t('deploy.form.mcVersion.placeholder.loading')
                          : t('deploy.form.mcVersion.placeholder.select')
                    }
                    emptyText={t('deploy.form.mcVersion.empty')}
                  />
                </div>
              </div>
              {coreType === 'paper' && (
                <div className="field">
                  <label id={`${nameFieldId}-paper-build-label`}>{t('deploy.form.paperBuild.label')}</label>
                  <LazyScrollSelect
                    labelId={`${nameFieldId}-paper-build-label`}
                    value={build}
                    options={builds.data ?? []}
                    onChange={setBuild}
                    onOpen={() => void builds.load()}
                    loading={builds.loading}
                    formatLabel={(b) => `#${b}`}
                    disabled={busy || !selectedMcVersion}
                    placeholder={t('deploy.form.paperBuild.placeholder')}
                    emptyText={t('deploy.form.paperBuild.empty')}
                  />
                </div>
              )}
              {hasLoader(coreType) && (
                <div className="field">
                  <label id={`${nameFieldId}-loader-label`}>{t('deploy.form.optionalLabel', { label: loaderLabel })}</label>
                  <LazyScrollSelect
                    labelId={`${nameFieldId}-loader-label`}
                    value={loaderVersion}
                    options={loaders.data?.loaders ?? []}
                    onChange={setLoaderVersion}
                    onOpen={() => void loaders.load()}
                    loading={loaders.loading}
                    disabled={busy || !selectedMcVersion}
                    placeholder={t('deploy.form.latestStable')}
                    emptyText={t('deploy.form.versionEmpty')}
                  />
                </div>
              )}
              {coreType === 'fabric' && (
                <div className="field">
                  <label id={`${nameFieldId}-installer-label`}>{t('deploy.form.installer.label')}</label>
                  <LazyScrollSelect
                    labelId={`${nameFieldId}-installer-label`}
                    value={installerVersion}
                    options={loaders.data?.installers ?? []}
                    onChange={setInstallerVersion}
                    onOpen={() => void loaders.load()}
                    loading={loaders.loading}
                    disabled={busy || !selectedMcVersion}
                    placeholder={t('deploy.form.latestStable')}
                    emptyText={t('deploy.form.versionEmpty')}
                  />
                </div>
              )}
              {(coreType === 'forge' || coreType === 'neoforge') && (
                <p className="field-help">
                  {t('deploy.form.forgeHelp')}
                </p>
              )}
              <DownloadSourceHint />
              {metadataError && <p className="error" role="alert">{t('deploy.form.metadataError', { error: metadataError })}</p>}
            </div>
          </section>

          <section className="form-section">
            <h2 className="form-section-title">
              <span className="step-badge" aria-hidden="true">3</span>
              {t('deploy.runtime.title')}
            </h2>
            <div className="card form-card">
              <JavaRuntimeSelect
                value={javaRuntimeId}
                onChange={setJavaRuntimeId}
                mcVersion={selectedMcVersion || null}
                disabled={busy}
                onResolvedMajorChange={setJavaMajor}
                autoSelect
                onInstallingChange={setJavaInstalling}
                onMatchStatusChange={setJavaStatus}
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

          {/* EULA 同意项在底部操作栏；这一节只放 Java 警告、部署进度和失败原因，都没有时整节不显示。 */}
          {showConfirm && (
          <section className="form-section deploy-confirm" ref={confirmRef}>
            <h2 className="form-section-title">
              <span className="step-badge" aria-hidden="true">4</span>
              {t('deploy.confirm.title')}
            </h2>
            <div className="card form-card">
              {javaStatus === 'mismatch' && !busy && (
                <p className="field-warn" role="status">
                  {t('deploy.confirm.javaRequired', { java: recommendedJavaMajor(selectedMcVersion) ?? '' })}
                </p>
              )}
              {progress && <TaskProgress task={progress} label={t('deploy.progress.label')} />}
              {busy && (
                <p className="field-help" role="status" aria-live="polite">
                  {t('deploy.progress.submitted')}
                </p>
              )}
              {error && (
                <ErrorSummary
                  key={error}
                  title={t('deploy.error.title')}
                  detailTitle={t('deploy.error.detailTitle')}
                  error={error}
                />
              )}
            </div>
          </section>
          )}

          <div className="action-bar">
            <span className="action-bar-status" role="status" aria-live="polite">
              {!busy && blocker
                ? t(blocker.key, blocker.params)
                : `${selectedCore?.name ?? ''}${selectedMcVersion ? ` ${selectedMcVersion}` : ''} · ${name.trim()}`}
            </span>
            {/* 必须由用户主动勾选；部署开始后和按钮一起禁用，避免请求途中被取消。 */}
            <label className="action-bar-check">
              <input type="checkbox" checked={acceptEula} disabled={busy} onChange={(e) => setAcceptEula(e.target.checked)} />
              <span>
                {rich('eula.agree.short', {
                  link: (chunk) => <a href={MINECRAFT_EULA_URL} target="_blank" rel="noreferrer" className="link">{chunk}</a>,
                })}
              </span>
            </label>
            <button
              className="btn btn-primary"
              type="button"
              disabled={busy || blocker !== null}
              onClick={() => void deploy()}
            >
              {busy ? t('deploy.action.running') : t('deploy.action.start')}
            </button>
          </div>
        </div>

        {/* 右侧新手指引：怎么选核心、部署后怎么进服 */}
        <aside className="card deploy-guide" aria-label={t('deploy.guide.ariaLabel')}>
          <h3>{t('deploy.guide.core.title')}</h3>
          <ul>
            <li>{rich('deploy.guide.core.paper', { strong: (chunk) => <strong>{chunk}</strong> })}</li>
            <li>{rich('deploy.guide.core.modded', { strong: (chunk) => <strong>{chunk}</strong> })}</li>
            <li>{rich('deploy.guide.core.vanilla', { strong: (chunk) => <strong>{chunk}</strong> })}</li>
          </ul>
          <h3>{t('deploy.guide.after.title')}</h3>
          <ol>
            <li>{rich('deploy.guide.after.start', { code: (chunk) => <code>{chunk}</code> })}</li>
            <li>{rich('deploy.guide.after.local', { code: (chunk) => <code>{chunk}</code> })}</li>
            <li>{t('deploy.guide.after.friends')}</li>
          </ol>
        </aside>
      </div>
    </div>
  );
}
