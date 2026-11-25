import { useEffect, useRef, useState } from 'react';
import { api, instanceApi } from '../api';
import { errorMessage } from '../errors';
import { useUnsavedGuard } from '../hooks/useUnsavedGuard';
import { useI18n, type MessageKey } from '../i18n';
import { integerIssue, type Issue } from '../validation';
import { FormFeedbackProvider, focusFirstInvalidField, useFieldFeedback, useFormFeedback } from './Field';
import { NumberInput } from './NumberInput';
import { SaveBar, useFormSubmit, useSavedNotice, type RestartControl } from './SaveBar';
import { UnsavedChangesDialog } from './UnsavedChangesDialog';

/**
 * Guided editor for server.properties:
 * common settings are shown in groups as a localized label + switch/dropdown/number control;
 * keys not covered are folded into "Advanced Options", keeping raw text editing.
 * Saving still submits the full key-value record; the server modifies only the last definition of each key, and preserves comments, blank lines and duplicate key lines.
 *
 * Keys not written in the file are shown with the game default (display only, not written into the file); keys the instance's game version no longer reads are not shown,
 * and old values left in the file are sent back as is on save.
 *
 * Switches are submitted together with the save bar like other items; the save bar appears only when there are changes. Errors on number items show only after blur.
 */

type FieldType = 'text' | 'number' | 'boolean' | 'select';

// Property key names (such as max-players) are technical names and not translated; labels, descriptions and option names store string keys, resolved in the current language at render time.
interface FieldMeta {
  key: string;
  labelKey: MessageKey;
  descKey: MessageKey;
  type: FieldType;
  options?: { value: string; labelKey: MessageKey }[];
  /** Value range of a number field, matching the Minecraft documentation; an omitted max means only a lower bound. */
  min?: number;
  max?: number;
  /**
   * The value the game actually uses when the file does not have this key: switches and dropdowns display it, and text and number boxes use it as the placeholder.
   * Checked item by item against the server.properties generated on first run by the official 1.21.8 and 1.21.10 servers;
   * spawn-animals no longer exists in either version, and its default is taken from the code that reads this key in the official 1.12.2 core.
   */
  defaultValue?: string;
  /** Placeholder text when the input is empty, taking precedence over defaultValue (an empty world seed means random and has no fixed default). */
  placeholderKey?: MessageKey;
  /** From this game version on the server no longer reads this key; the item is not shown when the instance version is known and not lower than it. */
  removedIn?: string;
  /** This key exists only from this game version on; the item is not shown when the instance version is known and earlier. */
  addedIn?: string;
}

interface GroupMeta {
  titleKey: MessageKey;
  fields: FieldMeta[];
  /** Some items in this group became game rules from version since: after they are hidden, the end of the group says where to set them. */
  gameRuleNote?: { key: MessageKey; since: string };
  /** Some items in this group were removed outright from version since (without becoming game rules): explained at the end of the group after hiding. */
  removedNote?: { key: MessageKey; since: string };
}

/** Parses the first three segments of a release version number (1.21.9, 26.3); returns null for unrecognized ones such as snapshot numbers (25w35a). */
function parseMcVersion(version: string | null | undefined): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(version ?? '');
  return match ? [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)] : null;
}

/** Returns false when the version is unknown or unrecognized: better to show one item too many than to hide a setting still in use. */
function isMcVersionAtLeast(version: string | null | undefined, since: string): boolean {
  const current = parseMcVersion(version);
  const target = parseMcVersion(since);
  if (!current || !target) return false;
  for (let index = 0; index < 3; index += 1) {
    if (current[index] !== target[index]) return current[index]! > target[index]!;
  }
  return true;
}

/** Returns true only when the version is known and earlier than since; returns false when the version is unknown, for the same reason as above. */
function isMcVersionBefore(version: string | null | undefined, since: string): boolean {
  return parseMcVersion(version) !== null && !isMcVersionAtLeast(version, since);
}

/** How many keys differ from when they were loaded (an addition, a deletion and a value change each count as one); the save bar uses this to write "N unsaved changes". */
function countChangedProperties(current: Record<string, string>, original: Record<string, string>): number {
  let count = 0;
  for (const key of new Set([...Object.keys(current), ...Object.keys(original)])) {
    if (current[key] !== original[key]) count += 1;
  }
  return count;
}

const GROUPS: GroupMeta[] = [
  {
    titleKey: 'config.group.basic',
    fields: [
      { key: 'motd', labelKey: 'config.field.motd.label', descKey: 'config.field.motd.desc', type: 'text', defaultValue: 'A Minecraft Server' },
      { key: 'server-port', labelKey: 'config.field.serverPort.label', descKey: 'config.field.serverPort.desc', type: 'number', min: 1, max: 65535, defaultValue: '25565' },
      { key: 'max-players', labelKey: 'config.field.maxPlayers.label', descKey: 'config.field.maxPlayers.desc', type: 'number', min: 0, defaultValue: '20' },
      {
        key: 'difficulty', labelKey: 'config.field.difficulty.label', descKey: 'config.field.difficulty.desc', type: 'select', defaultValue: 'easy',
        options: [
          { value: 'peaceful', labelKey: 'config.option.difficulty.peaceful' },
          { value: 'easy', labelKey: 'config.option.difficulty.easy' },
          { value: 'normal', labelKey: 'config.option.difficulty.normal' },
          { value: 'hard', labelKey: 'config.option.difficulty.hard' },
        ],
      },
      {
        key: 'gamemode', labelKey: 'config.field.gamemode.label', descKey: 'config.field.gamemode.desc', type: 'select', defaultValue: 'survival',
        options: [
          { value: 'survival', labelKey: 'config.option.gamemode.survival' },
          { value: 'creative', labelKey: 'config.option.gamemode.creative' },
          { value: 'adventure', labelKey: 'config.option.gamemode.adventure' },
          { value: 'spectator', labelKey: 'config.option.gamemode.spectator' },
        ],
      },
      { key: 'force-gamemode', labelKey: 'config.field.forceGamemode.label', descKey: 'config.field.forceGamemode.desc', type: 'boolean', defaultValue: 'false' },
    ],
  },
  {
    titleKey: 'config.group.multiplayer',
    gameRuleNote: { key: 'config.group.multiplayer.gameRuleNote', since: '1.21.9' },
    fields: [
      { key: 'online-mode', labelKey: 'config.field.onlineMode.label', descKey: 'config.field.onlineMode.desc', type: 'boolean', defaultValue: 'true' },
      { key: 'white-list', labelKey: 'config.field.whiteList.label', descKey: 'config.field.whiteList.desc', type: 'boolean', defaultValue: 'false' },
      { key: 'pvp', labelKey: 'config.field.pvp.label', descKey: 'config.field.pvp.desc', type: 'boolean', defaultValue: 'true', removedIn: '1.21.9' },
      { key: 'allow-flight', labelKey: 'config.field.allowFlight.label', descKey: 'config.field.allowFlight.desc', type: 'boolean', defaultValue: 'false' },
      { key: 'op-permission-level', labelKey: 'config.field.opPermissionLevel.label', descKey: 'config.field.opPermissionLevel.desc', type: 'number', min: 0, max: 4, defaultValue: '4' },
    ],
  },
  {
    titleKey: 'config.group.world',
    gameRuleNote: { key: 'config.group.world.gameRuleNote', since: '1.21.9' },
    removedNote: { key: 'config.group.world.animalsNote', since: '1.21.2' },
    fields: [
      { key: 'level-name', labelKey: 'config.field.levelName.label', descKey: 'config.field.levelName.desc', type: 'text', defaultValue: 'world' },
      { key: 'level-seed', labelKey: 'config.field.levelSeed.label', descKey: 'config.field.levelSeed.desc', type: 'text', placeholderKey: 'config.field.levelSeed.placeholder' },
      { key: 'allow-nether', labelKey: 'config.field.allowNether.label', descKey: 'config.field.allowNether.desc', type: 'boolean', defaultValue: 'true', removedIn: '1.21.9' },
      { key: 'spawn-monsters', labelKey: 'config.field.spawnMonsters.label', descKey: 'config.field.spawnMonsters.desc', type: 'boolean', defaultValue: 'true', removedIn: '1.21.9' },
      { key: 'spawn-animals', labelKey: 'config.field.spawnAnimals.label', descKey: 'config.field.spawnAnimals.desc', type: 'boolean', defaultValue: 'true', removedIn: '1.21.2' },
      { key: 'spawn-protection', labelKey: 'config.field.spawnProtection.label', descKey: 'config.field.spawnProtection.desc', type: 'number', min: 0, defaultValue: '16' },
    ],
  },
  {
    titleKey: 'config.group.performance',
    fields: [
      { key: 'view-distance', labelKey: 'config.field.viewDistance.label', descKey: 'config.field.viewDistance.desc', type: 'number', min: 3, max: 32, defaultValue: '10' },
      { key: 'simulation-distance', labelKey: 'config.field.simulationDistance.label', descKey: 'config.field.simulationDistance.desc', type: 'number', min: 3, max: 32, defaultValue: '10', addedIn: '1.18' },
      { key: 'network-compression-threshold', labelKey: 'config.field.networkCompressionThreshold.label', descKey: 'config.field.networkCompressionThreshold.desc', type: 'number', min: -1, defaultValue: '256' },
    ],
  },
];

const NUMBER_FIELDS = GROUPS.flatMap((group) => group.fields).filter((field) => field.type === 'number');
const KNOWN_KEYS = new Set(GROUPS.flatMap((group) => group.fields.map((field) => field.key)));
const FIELD_BY_KEY = new Map(GROUPS.flatMap((group) => group.fields.map((field) => [field.key, field] as const)));

/**
 * One settings row. Written as a module-level component: useFieldFeedback is a hook and cannot be called directly in a loop;
 * it cannot be defined inside ConfigTab either, or it would remount on every render and lose focus and the "blurred" record.
 */
function ConfigRow({
  field,
  raw,
  loaded,
  disabled,
  issue,
  onChange,
}: {
  field: FieldMeta;
  /** The raw value in the file; undefined when the key is absent. */
  raw: string | undefined;
  loaded: boolean;
  disabled: boolean;
  issue: Issue | null;
  onChange: (key: string, value: string) => void;
}) {
  const { t } = useI18n();
  const errorText = issue ? t(issue.key, issue.params) : null;
  // Validity is computed on every keystroke (it decides the save button); the red text shows only after blur, pressing Enter, or clicking the save bar's status text.
  const { shown, onBlur } = useFieldFeedback(errorText);
  // When the file does not have it, switches and dropdowns display the default the game actually uses; display only, and nothing is written into the file unless the user changes it.
  // Before the file is read (loading or read failure) defaults are not shown, so they are not mistaken for what is actually in the file.
  const fallback = loaded ? field.defaultValue : undefined;
  // When the file has the key with an empty value (verified on a 1.21.10 server): dropdown items and numbers take the default, switches act as "off", and text is simply empty.
  const value = (field.type === 'select' ? raw || fallback : raw ?? fallback) ?? '';
  // A text box uses the default as its placeholder only when the file does not have the key: clearing an existing value saves an empty value and does not return to the default.
  const placeholder = !loaded ? undefined
    : field.placeholderKey ? t(field.placeholderKey)
      : field.type === 'text' && raw !== undefined ? undefined
        : fallback;
  const inputId = `server-property-${field.key}`;
  const descId = `${inputId}-desc`;
  const errorId = `${inputId}-error`;
  const describedBy = shown ? `${descId} ${errorId}` : descId;
  return (
    // data-field-invalid is set whether or not the red text is showing, and focusFirstInvalidField uses it to find the first field to fix.
    <div className={`list-row config-row config-row-${field.type}`} data-field-invalid={issue ? '' : undefined}>
      <div className="list-row-text">
        <label htmlFor={inputId} className="list-row-title">{t(field.labelKey)}</label>
        <p className="list-row-desc" id={descId}>{t(field.descKey)}</p>
      </div>
      <div className="list-row-control">
        {field.type === 'boolean' ? (
          <input
            id={inputId}
            type="checkbox"
            role="switch"
            className="switch"
            checked={value === 'true'}
            disabled={disabled}
            aria-describedby={descId}
            onChange={(e) => onChange(field.key, e.target.checked ? 'true' : 'false')}
          />
        ) : field.type === 'select' ? (
          <select
            id={inputId}
            className="input"
            value={value}
            disabled={disabled}
            aria-describedby={descId}
            onChange={(e) => onChange(field.key, e.target.value)}
          >
            {/* "Please choose" is needed only when it is neither written nor has a default to display. */}
            {value === '' && (
              <option value="" disabled>
                {t('config.select.placeholder')}
              </option>
            )}
            {/* A value in the file that is not among the options is shown as is, or the dropdown would wrongly display the first item. */}
            {raw && !field.options?.some((option) => option.value === raw) && <option value={raw}>{raw}</option>}
            {field.options?.map((option) => (
              <option key={option.value} value={option.value}>
                {option.value === fallback
                  ? t('config.option.default', { label: t(option.labelKey) })
                  : t(option.labelKey)}
              </option>
            ))}
          </select>
        ) : field.type === 'number' ? (
          // A dirty value already in the file (such as abc) is shown as is; only what the user newly types is tidied.
          <NumberInput
            id={inputId}
            className="input"
            value={raw ?? ''}
            allowNegative={(field.min ?? 0) < 0}
            placeholder={placeholder}
            disabled={disabled}
            aria-invalid={shown ? true : undefined}
            aria-describedby={describedBy}
            onBlur={onBlur}
            onChange={(text) => onChange(field.key, text)}
          />
        ) : (
          <input
            id={inputId}
            className="input"
            type="text"
            value={raw ?? ''}
            placeholder={placeholder}
            disabled={disabled}
            aria-describedby={descId}
            onChange={(e) => onChange(field.key, e.target.value)}
          />
        )}
      </div>
      {/* The error goes last in the row: right below the input on narrow screens, and right-aligned under the input on wide screens. */}
      {shown && <p className="error config-row-error" id={errorId}>{errorText}</p>}
    </div>
  );
}

/**
 * Remounted by the parent per instance ID when the instance changes.
 * mcVersion is the instance's game version, used to hide items this version does not read; instances with an unknown version, such as custom jars, pass null and show everything as usual.
 * restart is the instance page's restart entry: while the instance is running, the notice after saving offers "Restart Instance"; when not passed, only a saved notice is shown.
 */
export function ConfigTab({
  instanceId,
  mcVersion = null,
  restart,
}: {
  instanceId: string;
  mcVersion?: string | null;
  restart?: RestartControl;
}) {
  const { t, tp, rich } = useI18n();
  const [props, setProps] = useState<Record<string, string>>({});
  const [originalProps, setOriginalProps] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const feedback = useFormFeedback();
  const savedNotice = useSavedNotice(restart);
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    void api<Record<string, string>>(instanceApi(instanceId, '/config/server.properties'), {
      signal: controller.signal,
    })
      .then((nextProps) => {
        if (controller.signal.aborted) return;
        setProps(nextProps);
        setOriginalProps(nextProps);
        setLoaded(true);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setError(errorMessage(err));
      });
    return () => controller.abort();
  }, [instanceId]);

  const dirtyCount = loaded ? countChangedProperties(props, originalProps) : 0;
  const dirty = dirtyCount > 0;
  // Only changed number fields are validated: an existing value in the file does not block saving even if malformed; only wrong values the user newly entered are blocked.
  const fieldIssues = new Map<string, Issue>();
  for (const field of NUMBER_FIELDS) {
    const value = props[field.key];
    if (value === undefined || value === originalProps[field.key]) continue;
    // Number items can be cleared: once saved as an empty value the server applies the default (which is what the placeholder shows), so an empty string is not an error.
    // A lone "-" is not an empty string; it counts as unfinished and is not saved as a clear.
    const issue = integerIssue(value, field.min ?? 0, field.max, true);
    if (issue) fieldIssues.set(field.key, issue);
  }
  const invalid = fieldIssues.size > 0;
  // The save bar names the first field to fix, so there is no hunting up and down a long page. The order matches the page, and the jump lands on the same item.
  const firstInvalid = NUMBER_FIELDS.find((field) => fieldIssues.has(field.key));
  const blocker = useUnsavedGuard(dirty, saving);

  async function save() {
    if (!loaded || !dirty || saving || invalid) return;
    setSaving(true);
    savedNotice.clear();
    try {
      await api(instanceApi(instanceId, '/config/server.properties'), {
        method: 'PUT',
        json: props,
      });
      setOriginalProps(props);
      feedback.reset();
      setError('');
      // server.properties is read only at start: a running instance has to restart for it to take effect.
      savedNotice.show(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  /** Makes the fields show their error reasons and jumps to the first field to fix; Enter failing to submit and clicking the save bar's status text are the same action. */
  function revealInvalid() {
    feedback.revealAll();
    focusFirstInvalidField(formRef.current);
  }

  function submit() {
    if (!loaded || !dirty || saving) return;
    if (invalid) revealInvalid();
    else void save();
  }

  const formSubmit = useFormSubmit(submit);

  function discard() {
    setProps(originalProps);
    feedback.reset();
    setError('');
  }

  const advancedKeys = Object.keys(props).filter((key) => !KNOWN_KEYS.has(key)).sort();

  function setValue(key: string, value: string) {
    // Collapse the "saved" notice on the next edit.
    savedNotice.clear();
    setProps((prev) => {
      // A key not originally in the file counts as unchanged when it returns to "not filled in", avoiding an extra line and a permanent "unsaved changes":
      // for text and number boxes that means cleared; switches and dropdowns have no "empty" state, so returning to the game default counts as not filled in.
      if (!(key in originalProps)) {
        const field = FIELD_BY_KEY.get(key);
        const backToDefault = (field?.type === 'boolean' || field?.type === 'select') && value === field.defaultValue;
        if (value === '' || backToDefault) {
          const { [key]: _removed, ...rest } = prev;
          return rest;
        }
      }
      return { ...prev, [key]: value };
    });
  }

  // Items this version does not read are not shown: already removed, or not added yet. Values left in the file are untouched and sent back as is on save.
  const isHidden = (field: FieldMeta) => (field.removedIn !== undefined && isMcVersionAtLeast(mcVersion, field.removedIn))
    || (field.addedIn !== undefined && isMcVersionBefore(mcVersion, field.addedIn));
  const disabled = !loaded || saving;

  return (
    <>
      <FormFeedbackProvider value={feedback.value}>
        {/* noValidate: validation is done by the page itself, so the browser's native prompts do not block submission. */}
        <form
          ref={formRef}
          className="form-stack config-workspace"
          noValidate
          {...formSubmit}
        >
          {error && <p className="callout callout-danger" role="alert">{error}</p>}
          {!loaded && !error && (
            <div className="page-loading" role="status">
              <span className="spinner" aria-hidden="true" />
              {t('config.loading')}
            </div>
          )}

          {/* On wide screens the groups are laid out in two columns; narrow screens keep one column. */}
          <div className="config-groups">
            {GROUPS.map((group) => (
              <section className="form-section" key={group.titleKey}>
                <h3 className="form-section-title">{t(group.titleKey)}</h3>
                <div className="list-group">
                  {group.fields.filter((field) => !isHidden(field)).map((field) => (
                    <ConfigRow
                      key={field.key}
                      field={field}
                      raw={props[field.key]}
                      loaded={loaded}
                      disabled={disabled}
                      issue={fieldIssues.get(field.key) ?? null}
                      onChange={setValue}
                    />
                  ))}
                </div>
                {group.gameRuleNote && isMcVersionAtLeast(mcVersion, group.gameRuleNote.since) && (
                  <p className="field-help">
                    {rich(group.gameRuleNote.key, { code: (chunk) => <code>{chunk}</code> })}
                  </p>
                )}
                {group.removedNote && isMcVersionAtLeast(mcVersion, group.removedNote.since) && (
                  <p className="field-help">{t(group.removedNote.key)}</p>
                )}
              </section>
            ))}
          </div>

          {advancedKeys.length > 0 && (
            <details className="disclosure config-advanced">
              <summary>{tp('config.advanced.summary', advancedKeys.length)}</summary>
              <div className="list-group">
                {advancedKeys.map((key) => {
                  const inputId = `server-property-${key}`;
                  return (
                    <div className="list-row config-row config-row-text" key={key}>
                      <div className="list-row-text">
                        <label htmlFor={inputId} className="list-row-title mono">{key}</label>
                      </div>
                      <div className="list-row-control">
                        <input
                          id={inputId}
                          className="input"
                          value={props[key] ?? ''}
                          disabled={disabled}
                          onChange={(e) => setValue(key, e.target.value)}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </details>
          )}

          <SaveBar
            dirtyCount={dirtyCount}
            saving={saving}
            saveLabel={t('config.save')}
            invalidLabel={firstInvalid ? t('validation.fixField', { field: t(firstInvalid.labelKey) }) : null}
            onFixInvalid={revealInvalid}
            onDiscard={discard}
            notice={savedNotice.notice}
            savedLabel={t('config.status.saved')}
            restart={restart}
            onDismissNotice={savedNotice.clear}
          />
        </form>
      </FormFeedbackProvider>

      <UnsavedChangesDialog
        blocker={blocker}
        saving={saving}
        title={t('config.unsaved.title')}
        savingTitle={t('config.unsaved.savingTitle')}
        description={t('config.unsaved.description')}
      />
    </>
  );
}
