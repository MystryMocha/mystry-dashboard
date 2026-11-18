import { useEffect, useState } from 'react';
import { api, instanceApi } from '../api';
import { errorMessage } from '../errors';
import { useUnsavedGuard } from '../hooks/useUnsavedGuard';
import { useI18n, type MessageKey } from '../i18n';
import { integerIssue, type Issue } from '../validation';
import { UnsavedChangesDialog } from './UnsavedChangesDialog';

/**
 * server.properties 引导化编辑器：
 * 常用配置按分组展示为中文标签 + 开关/下拉/数字控件；
 * 未收录的键折叠进「高级选项」保留原始文本编辑。
 * 保存仍提交完整的键值记录；服务端只修改每个 key 的最后一次定义，并保留注释、空行与重复键行。
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
}

interface GroupMeta {
  titleKey: MessageKey;
  fields: FieldMeta[];
}

function arePropertiesEqual(left: Record<string, string>, right: Record<string, string>): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length && leftKeys.every((key) => left[key] === right[key]);
}

const GROUPS: GroupMeta[] = [
  {
    titleKey: 'config.group.basic',
    fields: [
      { key: 'motd', labelKey: 'config.field.motd.label', descKey: 'config.field.motd.desc', type: 'text' },
      { key: 'server-port', labelKey: 'config.field.serverPort.label', descKey: 'config.field.serverPort.desc', type: 'number', min: 1, max: 65535 },
      { key: 'max-players', labelKey: 'config.field.maxPlayers.label', descKey: 'config.field.maxPlayers.desc', type: 'number', min: 0 },
      {
        key: 'difficulty', labelKey: 'config.field.difficulty.label', descKey: 'config.field.difficulty.desc', type: 'select',
        options: [
          { value: 'peaceful', labelKey: 'config.option.difficulty.peaceful' },
          { value: 'easy', labelKey: 'config.option.difficulty.easy' },
          { value: 'normal', labelKey: 'config.option.difficulty.normal' },
          { value: 'hard', labelKey: 'config.option.difficulty.hard' },
        ],
      },
      {
        key: 'gamemode', labelKey: 'config.field.gamemode.label', descKey: 'config.field.gamemode.desc', type: 'select',
        options: [
          { value: 'survival', labelKey: 'config.option.gamemode.survival' },
          { value: 'creative', labelKey: 'config.option.gamemode.creative' },
          { value: 'adventure', labelKey: 'config.option.gamemode.adventure' },
          { value: 'spectator', labelKey: 'config.option.gamemode.spectator' },
        ],
      },
      { key: 'force-gamemode', labelKey: 'config.field.forceGamemode.label', descKey: 'config.field.forceGamemode.desc', type: 'boolean' },
    ],
  },
  {
    titleKey: 'config.group.multiplayer',
    fields: [
      { key: 'online-mode', labelKey: 'config.field.onlineMode.label', descKey: 'config.field.onlineMode.desc', type: 'boolean' },
      { key: 'white-list', labelKey: 'config.field.whiteList.label', descKey: 'config.field.whiteList.desc', type: 'boolean' },
      { key: 'pvp', labelKey: 'config.field.pvp.label', descKey: 'config.field.pvp.desc', type: 'boolean' },
      { key: 'allow-flight', labelKey: 'config.field.allowFlight.label', descKey: 'config.field.allowFlight.desc', type: 'boolean' },
      { key: 'op-permission-level', labelKey: 'config.field.opPermissionLevel.label', descKey: 'config.field.opPermissionLevel.desc', type: 'number', min: 0, max: 4 },
    ],
  },
  {
    titleKey: 'config.group.world',
    fields: [
      { key: 'level-name', labelKey: 'config.field.levelName.label', descKey: 'config.field.levelName.desc', type: 'text' },
      { key: 'level-seed', labelKey: 'config.field.levelSeed.label', descKey: 'config.field.levelSeed.desc', type: 'text' },
      { key: 'allow-nether', labelKey: 'config.field.allowNether.label', descKey: 'config.field.allowNether.desc', type: 'boolean' },
      { key: 'spawn-monsters', labelKey: 'config.field.spawnMonsters.label', descKey: 'config.field.spawnMonsters.desc', type: 'boolean' },
      { key: 'spawn-animals', labelKey: 'config.field.spawnAnimals.label', descKey: 'config.field.spawnAnimals.desc', type: 'boolean' },
      { key: 'spawn-protection', labelKey: 'config.field.spawnProtection.label', descKey: 'config.field.spawnProtection.desc', type: 'number', min: 0 },
    ],
  },
  {
    titleKey: 'config.group.performance',
    fields: [
      { key: 'view-distance', labelKey: 'config.field.viewDistance.label', descKey: 'config.field.viewDistance.desc', type: 'number', min: 3, max: 32 },
      { key: 'simulation-distance', labelKey: 'config.field.simulationDistance.label', descKey: 'config.field.simulationDistance.desc', type: 'number', min: 3, max: 32 },
      { key: 'network-compression-threshold', labelKey: 'config.field.networkCompressionThreshold.label', descKey: 'config.field.networkCompressionThreshold.desc', type: 'number', min: -1 },
    ],
  },
];

const NUMBER_FIELDS = GROUPS.flatMap((group) => group.fields).filter((field) => field.type === 'number');
const KNOWN_KEYS = new Set(GROUPS.flatMap((group) => group.fields.map((field) => field.key)));

/** 切换实例时由上层按实例 ID 重新挂载。 */
export function ConfigTab({ instanceId }: { instanceId: string }) {
  const { t, tp } = useI18n();
  const [props, setProps] = useState<Record<string, string>>({});
  const [originalProps, setOriginalProps] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);

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

  const dirty = loaded && !arePropertiesEqual(props, originalProps);
  // 只校验改过的数字字段：文件里原有的值即使不规范也不拦保存，只拦用户新填的错误值。
  const fieldIssues = new Map<string, Issue>();
  for (const field of NUMBER_FIELDS) {
    const value = props[field.key];
    if (value === undefined || value === originalProps[field.key]) continue;
    const issue = integerIssue(value, field.min ?? 0, field.max);
    if (issue) fieldIssues.set(field.key, issue);
  }
  const invalid = fieldIssues.size > 0;
  // 操作栏点名第一个要改的字段，长页面里不用上下找。
  const firstInvalid = NUMBER_FIELDS.find((field) => fieldIssues.has(field.key));
  const blocker = useUnsavedGuard(dirty, saving);

  async function save() {
    if (!loaded || !dirty || saving || invalid) return;
    setSaving(true);
    setSaved(false);
    try {
      await api(instanceApi(instanceId, '/config/server.properties'), {
        method: 'PUT',
        json: props,
      });
      setOriginalProps(props);
      setSaved(true);
      setError('');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  const advancedKeys = Object.keys(props).filter((key) => !KNOWN_KEYS.has(key)).sort();

  function setValue(key: string, value: string) {
    setSaved(false);
    setProps((prev) => {
      // 文件里原本没有的键清空后视为没改，避免多写一行空值，也不会一直显示「有未保存的修改」。
      if (value === '' && !(key in originalProps)) {
        const { [key]: _removed, ...rest } = prev;
        return rest;
      }
      return { ...prev, [key]: value };
    });
  }

  function renderField(field: FieldMeta) {
    const raw = props[field.key];
    const inputId = `server-property-${field.key}`;
    const descId = `${inputId}-desc`;
    const disabled = !loaded || saving;
    const issue = fieldIssues.get(field.key);
    const errorId = `${inputId}-error`;
    return (
      <div className={`list-row config-row config-row-${field.type}`} key={field.key}>
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
              checked={(raw ?? 'false') === 'true'}
              disabled={disabled}
              aria-describedby={descId}
              onChange={(e) => setValue(field.key, e.target.checked ? 'true' : 'false')}
            />
          ) : field.type === 'select' ? (
            <select
              id={inputId}
              className="input"
              value={raw ?? ''}
              disabled={disabled}
              aria-describedby={descId}
              onChange={(e) => setValue(field.key, e.target.value)}
            >
              <option value="" disabled>
                {t('config.select.placeholder')}
              </option>
              {/* 文件里的值不在选项内时原样显示，否则下拉框会误显示成第一项。 */}
              {raw && !field.options?.some((option) => option.value === raw) && <option value={raw}>{raw}</option>}
              {field.options?.map((option) => (
                <option key={option.value} value={option.value}>
                  {t(option.labelKey)}
                </option>
              ))}
            </select>
          ) : (
            <input
              id={inputId}
              className="input"
              type={field.type === 'number' ? 'number' : 'text'}
              min={field.min}
              max={field.max}
              step={field.type === 'number' ? 1 : undefined}
              value={raw ?? ''}
              disabled={disabled}
              aria-invalid={issue ? true : undefined}
              aria-describedby={issue ? `${descId} ${errorId}` : descId}
              onChange={(e) => setValue(field.key, e.target.value)}
            />
          )}
        </div>
        {/* 说明放在整行最后：窄屏时紧跟在输入框下面，宽屏时右对齐在输入框下方。 */}
        {issue && <p className="error config-row-error" id={errorId}>{t(issue.key, issue.params)}</p>}
      </div>
    );
  }

  return (
    <div className="form-stack config-workspace">
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
            <div className="list-group">{group.fields.map(renderField)}</div>
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
                      disabled={!loaded || saving}
                      onChange={(e) => setValue(key, e.target.value)}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </details>
      )}

      <div className="action-bar">
        <span className="action-bar-status" role="status" aria-live="polite">
          {firstInvalid ? t('validation.fixField', { field: t(firstInvalid.labelKey) }) : dirty ? t('config.status.dirty') : saved ? t('config.status.saved') : t('config.status.idle')}
        </span>
        <button className="btn btn-primary" type="button" disabled={!loaded || !dirty || saving || invalid} onClick={() => void save()}>
          {saving ? t('action.saving') : t('config.save')}
        </button>
      </div>

      <UnsavedChangesDialog
        blocker={blocker}
        saving={saving}
        title={t('config.unsaved.title')}
        savingTitle={t('config.unsaved.savingTitle')}
        description={t('config.unsaved.description')}
      />
    </div>
  );
}
