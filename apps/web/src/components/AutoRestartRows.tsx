import { useEffect, useState } from 'react';
import { AUTO_RESTART_LIMITS, type AutoRestartSettings } from '@mystry/shared';
import { getAutoRestartSettings, saveAutoRestartSettings } from '../api';
import { errorMessage } from '../errors';
import { useI18n, type MessageKey } from '../i18n';
import { integerIssue } from '../validation';
import { Field } from './Field';
import { FlashNote, useFlash } from './MultiplayerLayout';
import { NumberInput } from './NumberInput';

type NumberKey = 'delaySeconds' | 'maxAttempts' | 'windowMinutes';

const NUMBER_FIELDS: { key: NumberKey; label: MessageKey; unit?: MessageKey; help?: MessageKey }[] = [
  { key: 'delaySeconds', label: 'settings.autoRestart.delay.label', unit: 'settings.autoRestart.delay.unit' },
  { key: 'maxAttempts', label: 'settings.autoRestart.max.label', help: 'settings.autoRestart.max.help' },
  {
    key: 'windowMinutes',
    label: 'settings.autoRestart.window.label',
    unit: 'settings.autoRestart.window.unit',
    help: 'settings.autoRestart.window.help',
  },
];

function numberText(settings: AutoRestartSettings): Record<NumberKey, string> {
  return {
    delaySeconds: String(settings.delaySeconds),
    maxAttempts: String(settings.maxAttempts),
    windowMinutes: String(settings.windowMinutes),
  };
}

/**
 * Restarting after a crash, for every instance: the switch saves at once, and the three numbers under it are saved
 * together with their own button, since a half-typed number must not be sent.
 */
export function AutoRestartRows() {
  const { t } = useI18n();
  /** null while loading; the switch is not clickable until then. */
  const [saved, setSaved] = useState<AutoRestartSettings | null>(null);
  const [draft, setDraft] = useState<Record<NumberKey, string> | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [flash, showFlash] = useFlash();

  useEffect(() => {
    let cancelled = false;
    getAutoRestartSettings()
      .then((settings) => {
        if (cancelled) return;
        setSaved(settings);
        setDraft(numberText(settings));
      })
      .catch((err) => {
        if (!cancelled) setError(errorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function save(next: AutoRestartSettings) {
    setSaving(true);
    setError('');
    try {
      const result = await saveAutoRestartSettings(next);
      setSaved(result);
      setDraft(numberText(result));
      showFlash(t('settings.autoRestart.saved'));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  const issues = NUMBER_FIELDS.map(({ key }) => (
    draft ? integerIssue(draft[key], AUTO_RESTART_LIMITS[key].min, AUTO_RESTART_LIMITS[key].max) : null
  ));
  const changed = saved !== null && draft !== null && NUMBER_FIELDS.some(({ key }) => draft[key] !== String(saved[key]));

  return (
    <>
      <div className="list-row">
        <div className="list-row-text">
          <label htmlFor="settings-auto-restart" className="list-row-title">{t('settings.autoRestart.label')}</label>
          <p className="list-row-desc" id="settings-auto-restart-desc">{t('settings.autoRestart.help')}</p>
          {error && <p className="error" role="alert">{error}</p>}
        </div>
        <div className="list-row-control">
          <input
            id="settings-auto-restart"
            type="checkbox"
            role="switch"
            className="switch"
            checked={saved?.enabled ?? false}
            disabled={saved === null || saving}
            aria-describedby="settings-auto-restart-desc"
            onChange={(event) => {
              if (saved) void save({ ...saved, enabled: event.target.checked });
            }}
          />
        </div>
      </div>
      {saved?.enabled && draft && (
        <div className="list-row">
          <div className="list-row-fields">
            <div className="grid grid-2">
              {NUMBER_FIELDS.map(({ key, label, unit, help }, index) => (
                <Field
                  key={key}
                  label={t(label)}
                  help={help ? t(help) : undefined}
                  error={issues[index] ? t(issues[index].key, issues[index].params) : null}
                >
                  {(control) => (
                    <NumberInput
                      {...control}
                      value={draft[key]}
                      disabled={saving}
                      suffix={unit ? t(unit) : undefined}
                      onChange={(text) => setDraft({ ...draft, [key]: text })}
                    />
                  )}
                </Field>
              ))}
            </div>
            <div className="list-row-fields-footer">
              <button
                className="btn btn-tinted"
                type="button"
                disabled={saving || !changed || issues.some(Boolean)}
                onClick={() => void save({
                  enabled: true,
                  delaySeconds: Number(draft.delaySeconds),
                  maxAttempts: Number(draft.maxAttempts),
                  windowMinutes: Number(draft.windowMinutes),
                })}
              >
                {saving ? t('action.saving') : t('action.save')}
              </button>
              <FlashNote text={flash} />
            </div>
          </div>
        </div>
      )}
      {/* With the numbers hidden there is nowhere else for "saved" to show after the switch is turned off. */}
      {!saved?.enabled && <FlashNote text={flash} />}
    </>
  );
}
