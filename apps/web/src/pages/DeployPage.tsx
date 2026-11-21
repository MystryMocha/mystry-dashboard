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
 * Where the action bar can jump to when it says "what is still missing". null means it is only waiting (loading versions, checking or installing Java) and there is no field to change.
 * runtime refers to the Java picker and the JVM configurator: the controls are in child components and are found through the data-field-invalid container this page wraps around them.
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
  // Paper, recommended for beginners, is selected by default, so the latest release can be deployed right on entering the page.
  const [coreType, setCoreType] = useState<CoreType | ''>('paper');
  const [mcVersion, setMcVersion] = useState('');
  const [build, setBuild] = useState<number | ''>('');
  const [loaderVersion, setLoaderVersion] = useState('');
  const [installerVersion, setInstallerVersion] = useState('');
  // The default instance name is generated in the UI language at the time the page is entered, and the user changes it afterwards.
  const [name, setName] = useState(() => t('deploy.form.name.default'));
  const [jvmArgs, setJvmArgs] = useState('-Xms1G -Xmx2G');
  const [javaRuntimeId, setJavaRuntimeId] = useState<string | null>(null);
  const [javaMajor, setJavaMajor] = useState<number | null>(null);
  const [jvmValid, setJvmValid] = useState(true);
  // The EULA must be checked by the user; it is never accepted on the user's behalf in advance.
  const [acceptEula, setAcceptEula] = useState(false);
  const [error, setError] = useState('');
  const [progress, setProgress] = useState<TaskInfo | null>(null);
  const [busy, setBusy] = useState(false);
  /** One-click Java install in progress: the new Java is selected automatically once installed, and deployment cannot start before then. */
  const [javaInstalling, setJavaInstalling] = useState(false);
  /** Deployment cannot start when the Java that will actually be used is not the recommended version: with the wrong Java a beginner's server will not start, and the error is incomprehensible to them. */
  const [javaStatus, setJavaStatus] = useState<JavaMatchStatus>('loading');
  /** Aborts in-progress task polling when the component unmounts, so requests and redirects do not continue after signing out or leaving the page. */
  const pollAbortRef = useRef<AbortController | null>(null);
  const coreOptionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  /** Section 4 (progress, failure reason): scrolls into view when a failure reason appears, so it is not covered by the action bar. */
  const confirmRef = useRef<HTMLElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  /** true from when the request is sent until this deployment ends: when Enter is pressed twice within the same event round, busy has not taken effect yet. */
  const submittingRef = useRef(false);
  const feedback = useFormFeedback();
  const baseId = useId();
  const nameId = `${baseId}-name`;
  const versionFieldId = `${baseId}-mc-version`;
  const eulaId = `${baseId}-eula`;

  // Metadata is cached by "core / core + version"; after switching, the old list is invalidated immediately and late old responses are discarded.
  const versions = useKeyedLoader(coreType || null, async () =>
    (await api<{ versions: string[] }>(`/api/cores/${coreType}/versions`)).versions);
  // The server returns releases newest first, and the latest version is used by default when none is chosen manually.
  const selectedMcVersion = mcVersion || versions.data?.[0] || '';
  const encodedMcVersion = encodeURIComponent(selectedMcVersion);
  const builds = useKeyedLoader(
    coreType === 'paper' && selectedMcVersion ? `paper:${selectedMcVersion}` : null,
    async () => (await api<{ builds: number[] }>(`/api/cores/paper/${encodedMcVersion}/builds`)).builds,
  );
  // Fabric's Installer and Loader come from the same API.
  const loaders = useKeyedLoader(
    hasLoader(coreType) && selectedMcVersion ? `${coreType}:${selectedMcVersion}` : null,
    () => api<{ loaders: string[]; installers?: string[] }>(`/api/cores/${coreType}/${encodedMcVersion}/loaders`),
  );
  const metadataError = versions.error || builds.error || loaders.error;
  const loadVersions = versions.load;

  useEffect(() => {
    return () => pollAbortRef.current?.abort();
  }, []);

  // The version list is fetched as soon as a core is chosen, without waiting for the user to open the dropdown.
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

  /** Radio group keyboard behavior: arrow keys move and select, and focus follows. */
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
    // Create and store the controller first: an unmount during the POST can then abort immediately, so polling is not left with no one in charge afterwards.
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
      // An abort caused by the component unmounting is not an error and needs no message.
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

  // Build, Loader and Installer left empty are resolved by the server to the latest stable version; only the core and game version are required.
  const nameIssue = instanceNameIssue(name);
  // Find the first unmet condition in the form's top-to-bottom order, and have the action bar say what is missing directly, rather than only greying out the button.
  const javaRecommended = recommendedJavaMajor(selectedMcVersion);
  // While the two "…ing" states and the version list are still loading there is no field to change, target is null, and the action bar shows plain text only.
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
  // An empty name is not marked red (the action bar already says to fill it in); only a filled-in but non-compliant one gives the Field an error reason.
  const nameError = name !== '' && nameIssue ? t(nameIssue.key, nameIssue.params) : null;
  // Only the one container currently in the way is flagged: JVM is checked before Java but sits below Java on the page, and flagging both would jump to the wrong one.
  const jvmBlocking = blocker?.issue.key === 'validation.jvm.invalid';
  const javaBlocking = blocker?.issue.key === 'validation.java.mismatch' || blocker?.issue.key === 'validation.java.unknown';
  const selectedCore = CORE_ITEMS.find((item) => item.id === coreType);
  const showConfirm = busy || progress !== null || error !== '';

  /** Makes the fields show their error reasons, and scrolls to and focuses the item currently blocking deployment. Shared by clicking the action bar's status text and by Enter failing to submit. */
  function jumpToBlocker() {
    feedback.revealAll();
    switch (blocker?.target) {
      case 'core':
        focusField(`${baseId}-core-0`);
        break;
      case 'version': {
        // The version dropdown is a custom-drawn button, not among the controls focusFirstInvalidField knows, so it is looked up here.
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

  /** The only entry point for form submission: the primary button and Enter in inputs both go through here. */
  function submitForm() {
    if (busy) return;
    if (blocker) {
      jumpToBlocker();
      return;
    }
    void deploy();
  }

  /**
   * While the primary button is disabled the browser does not trigger submit on Enter, so Enter in inputs is handled here in one place.
   * Multi-line text boxes, dropdowns, buttons and collapsible headings keep their own default behavior; Enter in checkboxes and radios does not submit.
   */
  function onFormKeyDown(event: React.KeyboardEvent<HTMLFormElement>) {
    if (event.key !== 'Enter' || event.defaultPrevented || event.nativeEvent.isComposing) return;
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) return;
    event.preventDefault();
    if (target.type === 'checkbox' || target.type === 'radio' || target.type === 'file') return;
    submitForm();
  }

  // Section 4 is at the bottom of a long page: on starting a deployment and on failure, scroll to where the progress or reason is visible (scroll-margin clears the bottom action bar).
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
              {/* The name and game version are both short, and sit side by side in one row when there is room. */}
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
              {/* The three optional items below are custom-drawn dropdowns (LazyScrollSelect wants the label's id) that do not fit into Field; "(optional)" uses the same string as Field. */}
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
              {/* The two child components are each wrapped in a container that takes no layout: when it blocks deployment it gets data-field-invalid, which the action bar and Enter use to jump to the control inside. */}
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

          {/* The EULA acceptance is in the bottom action bar; this section holds only deployment progress and the failure reason, and is not shown at all when there is neither. A Java version mismatch is explained by the Java picker and the action bar, and is not repeated here. */}
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
                // Problems that can be fixed are made into links: clicking jumps to that item and shows the reason. When only waiting for data there is nowhere to jump, so it stays plain text.
                <button type="button" className="link-button" onClick={jumpToBlocker}>
                  {t(blocker.issue.key, blocker.issue.params)}
                </button>
              ) : t(blocker.issue.key, blocker.issue.params)}
            </span>
            {/* Must be checked by the user; once deployment starts it is disabled together with the button, so it cannot be unchecked mid-request. */}
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

        {/* Beginner guide on the right: how to choose a core, and how to join the server after deploying */}
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
