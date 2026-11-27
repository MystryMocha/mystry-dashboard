import type { PanelMessage } from './messages/index.js';

/** Restarting a server after it crashes: one panel-wide setting that applies to every instance. */
export interface AutoRestartSettings {
  enabled: boolean;
  /** Seconds the panel waits after a crash before it starts the instance again. */
  delaySeconds: number;
  /** Restarts the panel makes in a row; one more crash leaves the instance crashed. */
  maxAttempts: number;
  /** Minutes a restarted server must stay up, counted from when it finished starting, for the count to start over. */
  windowMinutes: number;
}

export const AUTO_RESTART_DEFAULTS: AutoRestartSettings = {
  enabled: false,
  delaySeconds: 10,
  maxAttempts: 3,
  windowMinutes: 10,
};

export const AUTO_RESTART_LIMITS = {
  delaySeconds: { min: 5, max: 300 },
  maxAttempts: { min: 1, max: 10 },
  windowMinutes: { min: 5, max: 60 },
} as const;

/**
 * Where restarting after a crash stands for an instance. Kept in memory only, so it does not survive a panel restart.
 * `attempt` counts the restarts made in a row, starting at 1, and `max` is the limit that applied to this crash.
 */
export type InstanceAutoRestartState =
  | {
    state: 'scheduled';
    attempt: number;
    max: number;
    /** ISO time at which the panel starts the instance again. */
    at: string;
    /** Milliseconds left when the response was produced, so a client can count down without comparing its clock with the panel's. */
    remainingMs: number;
  }
  | {
    /** The limit was reached: the instance stays crashed until the user starts it. */
    state: 'gaveUp';
    attempt: number;
    max: number;
    at: string;
    windowMinutes: number;
  }
  | {
    /** The start was refused when the restart came due, or the restarted server crashed before it finished starting; it is not tried again. */
    state: 'failed';
    attempt: number;
    max: number;
    at: string;
    /** Why: a translatable message, or the original text of an error that has none. */
    reason: PanelMessage | string;
  };
