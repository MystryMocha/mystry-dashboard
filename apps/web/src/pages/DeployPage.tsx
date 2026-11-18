import { useEffect, useId, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Check } from 'lucide-react';
import { recommendedJavaMajor, type TaskInfo } from '@mystry/shared';
import { api, pollTask } from '../api';
import { CoreIcon } from '../components/CoreIcon';
import { DownloadSourceHint } from '../components/DownloadSourceSection';
import { MINECRAFT_EULA_URL } from '../components/EulaCheckbox';
import { ErrorSummary } from '../components/ErrorSummary';
import { Field, FormFeedbackProvider, focusField, focusFirstInvalidField, useFormFeedback } from '../components/Field';
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

/**
 * 操作栏说「还缺什么」时可以跳去的地方。null 表示只是在等（加载版本、检查或安装 Java），没有字段可改。
 * runtime 指 Java 选择框和 JVM 配置器：控件在子组件里，靠本页包在外面的 data-field-invalid 容器找到。
 */
type BlockerTarget = 'core' | 'version' | 'name' | 'runtime' | 'eula' | null;

interface Blocker {
  issue: Issue;
  target: BlockerTarget;
}

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
  /** 第 4 节（进度、失败原因）：出现失败原因时滚到可视范围，免得被操作栏挡住。 */
  const confirmRef = useRef<HTMLElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  /** 请求发出后到本次部署结束前为 true：同一轮事件里连按两次 Enter 时，busy 还没来得及生效。 */
  const submittingRef = useRef(false);
  const feedback = useFormFeedback();
  const baseId = useId();
  const nameId = `${baseId}-name`;
  const versionFieldId = `${baseId}-mc-version`;
  const eulaId = `${baseId}-eula`;

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
    if (!coreType || !selectedMcVersion || blocker || submittingRef.current) return;
    if (!jvmValid) {
      setError(t('deploy.error.jvmInvalid'));
      return;
    }
    submittingRef.current = true;
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
      submittingRef.current = false;
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
  // 两个「正在…」和版本列表还在加载时没有字段可改，target 为 null，操作栏只显示普通文字。
  const blocker: Blocker | null = !coreType ? { issue: { key: 'deploy.action.noCore' }, target: 'core' }
    : !selectedMcVersion ? { issue: { key: 'deploy.action.needVersion' }, target: versions.loading ? null : 'version' }
      : nameIssue ? { issue: nameIssue, target: 'name' }
        : !jvmValid ? { issue: { key: 'validation.jvm.invalid' }, target: 'runtime' }
          : javaInstalling ? { issue: { key: 'validation.java.installing' }, target: null }
            : javaStatus === 'loading' ? { issue: { key: 'validation.java.checking' }, target: null }
              : javaStatus === 'unknown' ? { issue: { key: 'validation.java.unknown' }, target: 'runtime' }
              : javaStatus === 'mismatch'
                ? { issue: { key: 'validation.java.mismatch', params: { java: javaRecommended ?? '' } }, target: 'runtime' }
                : !acceptEula ? { issue: { key: 'deploy.action.needEula' }, target: 'eula' }
                  : null;
  // 名称空着时不标红（操作栏已经说了要填），填了但不合规才给 Field 错误原因。
  const nameError = name !== '' && nameIssue ? t(nameIssue.key, nameIssue.params) : null;
  // 只给当前挡路的那一个容器打标记：JVM 排在 Java 前面检查，但在页面上位于 Java 下面，两个都标会跳错。
  const jvmBlocking = blocker?.issue.key === 'validation.jvm.invalid';
  const javaBlocking = blocker?.issue.key === 'validation.java.mismatch' || blocker?.issue.key === 'validation.java.unknown';
  const selectedCore = CORE_ITEMS.find((item) => item.id === coreType);
  const showConfirm = busy || progress !== null || error !== '';

  /** 让各字段显示错误原因，并滚动、聚焦到当前挡住部署的那一项。点操作栏的状态文字和按 Enter 提交不了时共用。 */
  function jumpToBlocker() {
    feedback.revealAll();
    switch (blocker?.target) {
      case 'core':
        focusField(`${baseId}-core-0`);
        break;
      case 'version': {
        // 版本下拉是自绘的按钮，不在 focusFirstInvalidField 认识的控件里，这里自己找。
        const trigger = document.getElementById(versionFieldId)?.querySelector<HTMLElement>('button');
        trigger?.scrollIntoView?.({ block: 'center' });
        trigger?.focus({ preventScroll: true });
        break;
      }
      case 'name':
        focusField(nameId);
        break;
      case 'runtime':
        focusFirstInvalidField(formRef.current);
        break;
      case 'eula':
        focusField(eulaId);
        break;
      default:
        break;
    }
  }

  /** 表单提交的唯一入口：主按钮、输入框里的 Enter 都走这里。 */
  function submitForm() {
    if (busy) return;
    if (blocker) {
      jumpToBlocker();
      return;
    }
    void deploy();
  }

  /**
   * 主按钮禁用时浏览器不会因为 Enter 触发 submit，所以输入框里的 Enter 统一在这里接。
   * 多行文本框、下拉框、按钮和折叠标题保持各自的默认行为；勾选框和单选框里的 Enter 不提交。
   */
  function onFormKeyDown(event: React.KeyboardEvent<HTMLFormElement>) {
    if (event.key !== 'Enter' || event.defaultPrevented || event.nativeEvent.isComposing) return;
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) return;
    event.preventDefault();
    if (target.type === 'checkbox' || target.type === 'radio' || target.type === 'file') return;
    submitForm();
  }

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
        <FormFeedbackProvider value={feedback.value}>
        <form
          className="form-stack"
          ref={formRef}
          noValidate
          onKeyDown={onFormKeyDown}
          onSubmit={(event) => {
            event.preventDefault();
            submitForm();
          }}
        >
          <section className="form-section" aria-labelledby={`${baseId}-core-title`}>
            <h2 className="form-section-title" id={`${baseId}-core-title`}>
              <span className="step-badge" aria-hidden="true">1</span>
              {t('deploy.core.title')}
            </h2>
            <div className="core-select-grid" role="radiogroup" aria-labelledby={`${baseId}-core-title`}>
              {CORE_ITEMS.map((item, index) => {
                const selected = coreType === item.id;
                return (
                  <button
                    key={item.id}
                    id={`${baseId}-core-${index}`}
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
                <Field id={nameId} label={t('deploy.form.name.label')} error={nameError}>
                  {(control) => (
                    <input
                      {...control}
                      value={name}
                      disabled={busy}
                      onChange={(e) => setName(e.target.value)}
                    />
                  )}
                </Field>

                <div className="field" id={versionFieldId}>
                  <label id={`${baseId}-mc-version-label`}>{t('deploy.form.mcVersion.label')}</label>
                  <LazyScrollSelect
                    labelId={`${baseId}-mc-version-label`}
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
              {/* 下面三个可选项是自绘下拉（LazyScrollSelect 要的是标签的 id），套不进 Field，「（可选）」用和 Field 相同的那条文案。 */}
              {coreType === 'paper' && (
                <div className="field">
                  <label id={`${baseId}-paper-build-label`}>{t('common.optionalLabel', { label: t('deploy.form.paperBuild.label') })}</label>
                  <LazyScrollSelect
                    labelId={`${baseId}-paper-build-label`}
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
                  <label id={`${baseId}-loader-label`}>{t('common.optionalLabel', { label: loaderLabel })}</label>
                  <LazyScrollSelect
                    labelId={`${baseId}-loader-label`}
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
                  <label id={`${baseId}-installer-label`}>{t('common.optionalLabel', { label: t('deploy.form.installer.label') })}</label>
                  <LazyScrollSelect
                    labelId={`${baseId}-installer-label`}
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
              {/* 两个子组件各包一层不占布局的容器：挡住部署时打上 data-field-invalid，操作栏和 Enter 据此跳到里面的控件。 */}
              <div className="deploy-field-anchor" data-field-invalid={javaBlocking ? '' : undefined}>
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
              </div>
              <div className="deploy-field-anchor" data-field-invalid={jvmBlocking ? '' : undefined}>
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
            </div>
          </section>

          {/* EULA 同意项在底部操作栏；这一节只放部署进度和失败原因，都没有时整节不显示。Java 版本不符由 Java 选择框和操作栏说明，这里不再重复。 */}
          {showConfirm && (
          <section className="form-section deploy-confirm" ref={confirmRef}>
            <h2 className="form-section-title">
              <span className="step-badge" aria-hidden="true">4</span>
              {t('deploy.confirm.title')}
            </h2>
            <div className="card form-card">
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
              {busy || !blocker ? (
                `${selectedCore?.name ?? ''}${selectedMcVersion ? ` ${selectedMcVersion}` : ''} · ${name.trim()}`
              ) : blocker.target ? (
                // 能改的问题做成链接：点了跳到那一项并显示原因。只是在等数据时没有可跳的地方，保持普通文字。
                <button type="button" className="link-button" onClick={jumpToBlocker}>
                  {t(blocker.issue.key, blocker.issue.params)}
                </button>
              ) : t(blocker.issue.key, blocker.issue.params)}
            </span>
            {/* 必须由用户主动勾选；部署开始后和按钮一起禁用，避免请求途中被取消。 */}
            <label className="action-bar-check">
              <input id={eulaId} type="checkbox" checked={acceptEula} disabled={busy} onChange={(e) => setAcceptEula(e.target.checked)} />
              <span>
                {rich('eula.agree.short', {
                  link: (chunk) => <a href={MINECRAFT_EULA_URL} target="_blank" rel="noreferrer" className="link">{chunk}</a>,
                })}
              </span>
            </label>
            <button
              className="btn btn-primary"
              type="submit"
              disabled={busy || blocker !== null}
            >
              {busy ? t('deploy.action.running') : t('deploy.action.start')}
            </button>
          </div>
        </form>
        </FormFeedbackProvider>

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
