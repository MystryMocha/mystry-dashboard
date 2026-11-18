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
 * server.properties 引导化编辑器：
 * 常用配置按分组展示为中文标签 + 开关/下拉/数字控件；
 * 未收录的键折叠进「高级选项」保留原始文本编辑。
 * 保存仍提交完整的键值记录；服务端只修改每个 key 的最后一次定义，并保留注释、空行与重复键行。
 *
 * 文件里没写的键按游戏默认值显示（只显示，不写进文件）；实例的游戏版本已经不读的键不显示，
 * 文件里留着的旧值保存时原样带回。
 *
 * 开关和其他项一样随保存栏一起提交；保存栏只在有修改时出现。数字项的错误在失焦后才显示。
 */

type FieldType = 'text' | 'number' | 'boolean' | 'select';

// 属性键名（如 max-players）是技术名不翻译；标签、说明与选项名存文案键，渲染时再取当前语言。
interface FieldMeta {
  key: string;
  labelKey: MessageKey;
  descKey: MessageKey;
  type: FieldType;
  options?: { value: string; labelKey: MessageKey }[];
  /** 数字字段的取值范围，与 Minecraft 文档一致；max 省略表示只限下限。 */
  min?: number;
  max?: number;
  /**
   * 文件里没写这个键时游戏实际使用的值：开关和下拉按它显示，文本和数字框拿它做占位字。
   * 已和 1.21.8、1.21.10 官方服务端首次运行生成的 server.properties 逐项核对；
   * spawn-animals 这两个版本都已经没有，它的默认值取自 1.12.2 官方核心里读这个键的代码。
   */
  defaultValue?: string;
  /** 输入框为空时的占位文案，优先于 defaultValue（世界种子留空表示随机，没有固定默认值）。 */
  placeholderKey?: MessageKey;
  /** 从这个游戏版本起服务端不再读这个键；实例版本已知且不低于它时不显示这一项。 */
  removedIn?: string;
  /** 从这个游戏版本起才有这个键；实例版本已知且更早时不显示这一项。 */
  addedIn?: string;
}

interface GroupMeta {
  titleKey: MessageKey;
  fields: FieldMeta[];
  /** 本组有项从 since 版本起改成了游戏规则：这些项隐藏后，在组末尾说明去哪里设置。 */
  gameRuleNote?: { key: MessageKey; since: string };
  /** 本组有项从 since 版本起被直接去掉（没有变成游戏规则）：隐藏后在组末尾说明。 */
  removedNote?: { key: MessageKey; since: string };
}

/** 解析正式版版本号的前三段（1.21.9、26.3）；快照号（25w35a）等认不出的返回 null。 */
function parseMcVersion(version: string | null | undefined): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(version ?? '');
  return match ? [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)] : null;
}

/** 版本未知或认不出时返回 false：宁可多显示一项，也不把还在用的设置藏起来。 */
function isMcVersionAtLeast(version: string | null | undefined, since: string): boolean {
  const current = parseMcVersion(version);
  const target = parseMcVersion(since);
  if (!current || !target) return false;
  for (let index = 0; index < 3; index += 1) {
    if (current[index] !== target[index]) return current[index]! > target[index]!;
  }
  return true;
}

/** 版本已知且早于 since 才返回 true；版本未知时返回 false，理由同上。 */
function isMcVersionBefore(version: string | null | undefined, since: string): boolean {
  return parseMcVersion(version) !== null && !isMcVersionAtLeast(version, since);
}

/** 有几个键和加载时不一样（新增、删除、改值各算一项），保存栏据此写「N 项修改未保存」。 */
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
 * 一行设置。写成模块顶层的组件：useFieldFeedback 是钩子，不能在循环里直接调用；
 * 也不能定义在 ConfigTab 里面，否则每次渲染都会重新挂载，丢掉焦点和「失焦过」的记录。
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
  /** 文件里的原始值；没有这个键时是 undefined。 */
  raw: string | undefined;
  loaded: boolean;
  disabled: boolean;
  issue: Issue | null;
  onChange: (key: string, value: string) => void;
}) {
  const { t } = useI18n();
  const errorText = issue ? t(issue.key, issue.params) : null;
  // 合不合法每次按键都算（决定保存按钮）；红字等失焦、按 Enter 或点了保存栏的状态文字之后才显示。
  const { shown, onBlur } = useFieldFeedback(errorText);
  // 文件里没写时，开关和下拉显示游戏实际使用的默认值；只是显示，用户不改就不会写进文件。
  // 文件还没读到（加载中或读取失败）时不显示默认值，免得被当成文件里的实际情况。
  const fallback = loaded ? field.defaultValue : undefined;
  // 文件里写了键但值留空时（在 1.21.10 服务端上实测）：下拉项和数字按默认值生效，开关按「关」生效，文本就是空的。
  const value = (field.type === 'select' ? raw || fallback : raw ?? fallback) ?? '';
  // 文本框只在文件里没有这个键时才拿默认值做占位字：清空一个已有的值会存成空值，不会回到默认值。
  const placeholder = !loaded ? undefined
    : field.placeholderKey ? t(field.placeholderKey)
      : field.type === 'text' && raw !== undefined ? undefined
        : fallback;
  const inputId = `server-property-${field.key}`;
  const descId = `${inputId}-desc`;
  const errorId = `${inputId}-error`;
  const describedBy = shown ? `${descId} ${errorId}` : descId;
  return (
    // data-field-invalid 不管红字显没显示都标着，focusFirstInvalidField 靠它找到第一个要改的字段。
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
            {/* 只有既没写、也没有默认值可显示时才需要「请选择」。 */}
            {value === '' && (
              <option value="" disabled>
                {t('config.select.placeholder')}
              </option>
            )}
            {/* 文件里的值不在选项内时原样显示，否则下拉框会误显示成第一项。 */}
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
          // 文件里原有的脏值（如 abc）原样显示；只整理用户新输入的内容。
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
      {/* 说明放在整行最后：窄屏时紧跟在输入框下面，宽屏时右对齐在输入框下方。 */}
      {shown && <p className="error config-row-error" id={errorId}>{errorText}</p>}
    </div>
  );
}

/**
 * 切换实例时由上层按实例 ID 重新挂载。
 * mcVersion 是实例的游戏版本，用来隐藏这个版本不读的项；自定义 Jar 等版本未知的实例传 null，全部照常显示。
 * restart 是实例页的重启入口：实例在运行时，保存后的提示里给出「重启实例」；不传时只提示已保存。
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
  // 只校验改过的数字字段：文件里原有的值即使不规范也不拦保存，只拦用户新填的错误值。
  const fieldIssues = new Map<string, Issue>();
  for (const field of NUMBER_FIELDS) {
    const value = props[field.key];
    if (value === undefined || value === originalProps[field.key]) continue;
    // 数字项可以清空：存成空值后服务端按默认值生效（占位字显示的就是它），所以空串不算错。
    // 只输了一个「-」不是空串，算没输完，不会被当成清空存进去。
    const issue = integerIssue(value, field.min ?? 0, field.max, true);
    if (issue) fieldIssues.set(field.key, issue);
  }
  const invalid = fieldIssues.size > 0;
  // 保存栏点名第一个要改的字段，长页面里不用上下找。顺序和页面上的一致，跳转时落在同一项上。
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
      // server.properties 只在启动时读取：实例在运行就要重启才生效。
      savedNotice.show(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  /** 让各字段显示错误原因，并跳到第一个要改的字段；按 Enter 提交不了和点保存栏的状态文字是同一个动作。 */
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
    // 再次修改时收起「已保存」的提示。
    savedNotice.clear();
    setProps((prev) => {
      // 文件里原本没有的键回到「没填」时视为没改，避免多写一行，也不会一直显示「有未保存的修改」：
      // 文本和数字框是清空；开关和下拉没有「空」这个状态，回到游戏默认值就算没填。
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

  // 这个版本不读的项不显示：已经移除的，或者还没加入的。文件里留着的值不动，保存时原样带回。
  const isHidden = (field: FieldMeta) => (field.removedIn !== undefined && isMcVersionAtLeast(mcVersion, field.removedIn))
    || (field.addedIn !== undefined && isMcVersionBefore(mcVersion, field.addedIn));
  const disabled = !loaded || saving;

  return (
    <>
      <FormFeedbackProvider value={feedback.value}>
        {/* noValidate：校验由页面自己做，不让浏览器的原生提示拦住提交。 */}
        <form
          ref={formRef}
          className="form-stack config-workspace"
          noValidate
          {...formSubmit}
        >
          <p className="section-lead">{t('config.lead')}</p>
          {error && <p className="callout callout-danger" role="alert">{error}</p>}
          {!loaded && !error && (
            <div className="page-loading" role="status">
              <span className="spinner" aria-hidden="true" />
              {t('config.loading')}
            </div>
          )}

          {/* 宽屏时各分组排成两列，窄屏仍是一列。 */}
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
