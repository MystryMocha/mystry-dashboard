import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { AlertCircle, CalendarClock, ChevronDown } from 'lucide-react';
import {
  BACKUP_SCHEDULE_MAX_KEEP,
  BACKUP_SCHEDULE_TIME_PATTERN,
  type BackupScheduleInfo,
  type BackupScheduleInput,
} from '@mystry/shared';
import { getBackupSchedule, saveBackupSchedule } from '../api';
import { errorMessage, isAbortError } from '../errors';
import { useI18n } from '../i18n';
import { integerIssue } from '../validation';
import { ConfirmDialog } from './ConfirmDialog';
import { Field } from './Field';
import { FlashNote, useFlash } from './MultiplayerLayout';
import { NumberInput } from './NumberInput';
import { StatusPill } from './StatusPill';

const TIME_OF_DAY = new RegExp(BACKUP_SCHEDULE_TIME_PATTERN);
const TIME_OF_DAY_FORMAT: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: '2-digit' };

/** A response of another shape (an older server, a proxy's error page) is ignored rather than rendered as a schedule. */
function isSchedule(value: unknown): value is BackupScheduleInfo {
  const schedule = value as Partial<BackupScheduleInfo> | null;
  return typeof schedule?.enabled === 'boolean'
    && typeof schedule.time === 'string'
    && typeof schedule.keep === 'number'
    && typeof schedule.utcOffsetMinutes === 'number';
}

/**
 * The daily automatic backup of one instance: a switch that applies at once, how the latest run went, and the time and
 * count behind a disclosure. `scheduledCount` is how many automatic backups the list holds now; `reloadSignal` changes
 * whenever the list was read again, so the latest run is read again with it.
 */
export function BackupScheduleSection({
  instanceId,
  scheduledCount,
  reloadSignal,
}: {
  instanceId: string;
  scheduledCount: number;
  reloadSignal: number;
}) {
  const { t, tp, tm, fmt } = useI18n();
  const switchId = useId();
  const summaryId = useId();
  const panelId = useId();
  const [schedule, setSchedule] = useState<BackupScheduleInfo | null>(null);
  const [loadError, setLoadError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [time, setTime] = useState('');
  const [keep, setKeep] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  // A time or count the user is editing is not overwritten when the schedule is read again; it follows the server once saved.
  const edited = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirmKeep, setConfirmKeep] = useState<number | null>(null);
  const [saved, showSaved] = useFlash();
  // Goes up when a save begins and again when it ends. A read answers with the schedule as it was at some moment while
  // the read was under way, so one that overlapped a save may arrive after it with what the save replaced. Such an
  // answer is dropped, and the schedule is read again once the save is over.
  const saveMarks = useRef(0);

  const apply = useCallback((next: BackupScheduleInfo) => {
    setSchedule(next);
    if (!edited.current) {
      setTime(next.time);
      setKeep(String(next.keep));
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const sentAt = saveMarks.current;
    const current = () => !controller.signal.aborted && saveMarks.current === sentAt;
    setLoadError('');
    getBackupSchedule(instanceId, controller.signal)
      .then((next) => {
        if (current() && isSchedule(next)) apply(next);
      })
      .catch((err: unknown) => {
        if (current() && !isAbortError(err)) setLoadError(errorMessage(err));
      });
    return () => controller.abort();
  }, [apply, instanceId, reloadSignal, attempt]);

  const timeError = time !== '' && !TIME_OF_DAY.test(time) ? t('backups.auto.time.invalid') : null;
  const keepIssue = keep === '' ? null : integerIssue(keep, 1, BACKUP_SCHEDULE_MAX_KEEP);
  const complete = time !== '' && keep !== '' && !timeError && !keepIssue;
  const changed = schedule !== null && (time !== schedule.time || keep !== String(schedule.keep));

  async function commit(input: BackupScheduleInput): Promise<boolean> {
    setBusy(true);
    setError('');
    saveMarks.current += 1;
    try {
      const next = await saveBackupSchedule(instanceId, input);
      if (isSchedule(next)) apply(next);
      return true;
    } catch (err) {
      setError(errorMessage(err));
      return false;
    } finally {
      saveMarks.current += 1;
      setBusy(false);
      // Also after a save that failed: a read dropped meanwhile carried how the latest run went.
      setAttempt((count) => count + 1);
    }
  }

  function toggle(enabled: boolean) {
    if (!schedule) return;
    // The switch goes with the time and count already saved, not with ones still being edited below.
    void commit({ enabled, time: schedule.time, keep: schedule.keep });
  }

  async function saveSettings(nextKeep: number) {
    if (!schedule) return;
    const wasEdited = edited.current;
    edited.current = false;
    if (await commit({ enabled: schedule.enabled, time, keep: nextKeep })) showSaved(t('backups.auto.saved'));
    else edited.current = wasEdited;
  }

  function submitSettings() {
    if (!schedule || !complete || !changed || busy) return;
    const nextKeep = Number(keep);
    // Keeping fewer than there are now deletes the rest after the next run, which cannot be taken back.
    if (nextKeep < schedule.keep && scheduledCount > nextKeep) setConfirmKeep(nextKeep);
    else void saveSettings(nextKeep);
  }

  function utcOffsetLabel(offset: number): string {
    if (offset === 0) return t('backups.auto.zone.utc');
    const total = Math.abs(offset);
    const signedHours = fmt.number(Math.sign(offset) * Math.floor(total / 60), { signDisplay: 'always' });
    const rest = total % 60;
    return rest
      ? t('backups.auto.zone.hoursMinutes', { hours: signedHours, minutes: fmt.number(rest, { minimumIntegerDigits: 2 }) })
      : t('backups.auto.zone.hours', { hours: signedHours });
  }

  const [hours, minutes] = (schedule?.time ?? '').split(':').map(Number);
  const displayTime = schedule ? fmt.dateTime(new Date(2001, 0, 1, hours, minutes), TIME_OF_DAY_FORMAT) : '';
  const zone = schedule ? utcOffsetLabel(schedule.utcOffsetMinutes) : '';
  // The clock is named only when this browser reads another one; on the panel computer itself it would be noise.
  const sameClock = schedule !== null && schedule.utcOffsetMinutes === (-new Date().getTimezoneOffset() || 0);
  const lastFailure = schedule?.lastFailure ?? null;
  const summaryText = schedule
    ? tp(sameClock ? 'backups.auto.summary' : 'backups.auto.summaryOtherClock', schedule.keep, { time: displayTime, zone })
    : '';

  return (
    <section
      className={`backups-schedule${schedule?.enabled ? ' is-enabled' : ''}${lastFailure ? ' has-failure' : ''}`}
      aria-labelledby={switchId}
    >
      <div className="backups-schedule-row">
        <div className="backups-schedule-main">
          <span className="backups-schedule-icon" aria-hidden="true">
            <CalendarClock size={18} />
          </span>
          <div className="backups-schedule-text">
            <div className="backups-schedule-title-row">
              <label className="backups-schedule-title" id={switchId} htmlFor={`${switchId}-input`}>
                {t('backups.auto.switch')}
              </label>
              {lastFailure && (
                <StatusPill tone="crashed">{t('task.status.failed')}</StatusPill>
              )}
            </div>
            {schedule && (
              <p className="backups-schedule-summary" id={summaryId}>
                {summaryText}
                {!lastFailure && schedule.lastBackupAt && (
                  <>
                    {' · '}
                    {t('backups.auto.lastRun', { date: fmt.dateTime(schedule.lastBackupAt) })}
                  </>
                )}
              </p>
            )}
            {loadError && (
              <div className="settings-load-error">
                <p className="error" role="alert">{loadError}</p>
                <button type="button" className="link-button" onClick={() => setAttempt((count) => count + 1)}>
                  {t('action.retry')}
                </button>
              </div>
            )}
            {error && <p className="error" role="alert">{error}</p>}
          </div>
        </div>
        <div className="backups-schedule-controls">
          {schedule && (
            <button
              type="button"
              className={`btn btn-sm btn-plain backups-schedule-edit${settingsOpen ? ' is-open' : ''}`}
              aria-expanded={settingsOpen}
              aria-controls={panelId}
              onClick={() => setSettingsOpen((open) => !open)}
            >
              {t('backups.auto.settings')}
              <ChevronDown size={14} aria-hidden="true" className="backups-schedule-chevron" />
            </button>
          )}
          <input
            id={`${switchId}-input`}
            type="checkbox"
            role="switch"
            className="switch"
            checked={schedule?.enabled ?? false}
            disabled={!schedule || busy}
            aria-describedby={schedule ? summaryId : undefined}
            onChange={(event) => toggle(event.target.checked)}
          />
        </div>
      </div>

      {schedule && lastFailure && (
        <div className="callout callout-danger backups-schedule-failure" role="alert">
          <AlertCircle size={17} aria-hidden="true" className="callout-icon" />
          <div className="backups-schedule-failure-body">
            <p>
              <strong>{t('backups.auto.last.failed', { date: fmt.dateTime(lastFailure.at) })}</strong>
            </p>
            <p>{tm(lastFailure.errorI18n, lastFailure.error)}</p>
            {schedule.lastBackupAt && (
              <p className="backups-schedule-failure-prev">
                {t('backups.auto.last.previous', { date: fmt.dateTime(schedule.lastBackupAt) })}
              </p>
            )}
          </div>
        </div>
      )}

      {schedule && settingsOpen && (
        <div id={panelId} className="backups-schedule-panel">
          <div className="grid grid-2">
            <Field label={t('backups.auto.time.label')} help={t('backups.auto.time.help', { zone })} error={timeError}>
              {(control) => (
                <input
                  {...control}
                  type="time"
                  value={time}
                  disabled={busy}
                  onChange={(event) => {
                    edited.current = true;
                    setTime(event.target.value);
                  }}
                />
              )}
            </Field>
            <Field
              label={t('backups.auto.keep.label')}
              help={t('backups.auto.keep.help')}
              error={keepIssue ? t(keepIssue.key, keepIssue.params) : null}
            >
              {(control) => (
                <NumberInput
                  {...control}
                  value={keep}
                  disabled={busy}
                  onChange={(text) => {
                    edited.current = true;
                    setKeep(text);
                  }}
                />
              )}
            </Field>
          </div>
          <p className="field-help">{t('backups.auto.skip')}</p>
          <div className="backups-schedule-panel-footer">
            <button className="btn btn-tinted" type="button" disabled={busy || !complete || !changed} onClick={submitSettings}>
              {busy ? t('action.saving') : t('backups.auto.save')}
            </button>
            <FlashNote text={saved} />
          </div>
        </div>
      )}

      <ConfirmDialog
        open={confirmKeep !== null}
        title={confirmKeep === null ? '' : tp('backups.auto.confirm.title', confirmKeep)}
        description={confirmKeep === null ? '' : tp('backups.auto.confirm.description', confirmKeep, { have: fmt.number(scheduledCount) })}
        confirmLabel={confirmKeep === null ? undefined : tp('backups.auto.confirm.action', confirmKeep)}
        danger
        busy={busy}
        onConfirm={() => {
          const nextKeep = confirmKeep;
          if (nextKeep === null) return;
          void saveSettings(nextKeep).finally(() => setConfirmKeep(null));
        }}
        onCancel={() => setConfirmKeep(null)}
      />
    </section>
  );
}
