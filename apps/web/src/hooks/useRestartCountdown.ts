import { useEffect, useRef, useState } from 'react';
import type { InstanceAutoRestartState } from '@mystry/shared';

/** How long after the countdown ends the instance is read again: the panel starts the server at about that moment. */
const REFRESH_AFTER_ZERO_MS = 600;

/**
 * Seconds until the restart the panel scheduled after a crash, counted down locally between polls; null when none is waiting.
 * The deadline is taken from `remainingMs` when a restart first shows up, not from its timestamp: this device's clock
 * and the panel's may differ, so `at` only tells one scheduled restart from the next.
 */
export function useRestartCountdown(
  state: InstanceAutoRestartState | null | undefined,
  onElapsed: () => void,
): number | null {
  const scheduled = state?.state === 'scheduled' ? state : null;
  const at = scheduled?.at ?? null;
  const remainingMs = scheduled?.remainingMs ?? 0;
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);
  const remainingRef = useRef(remainingMs);
  remainingRef.current = remainingMs;
  const onElapsedRef = useRef(onElapsed);
  onElapsedRef.current = onElapsed;

  useEffect(() => {
    if (!at) {
      setSecondsLeft(null);
      return;
    }
    const deadline = Date.now() + remainingRef.current;
    let refresh: number | undefined;
    const tick = () => {
      const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      setSecondsLeft(left);
      if (left > 0) return;
      window.clearInterval(timer);
      refresh = window.setTimeout(() => onElapsedRef.current(), REFRESH_AFTER_ZERO_MS);
    };
    const timer = window.setInterval(tick, 1000);
    tick();
    return () => {
      window.clearInterval(timer);
      window.clearTimeout(refresh);
    };
  }, [at]);

  if (!at) return null;
  // Before the effect has run for a restart that just appeared, show what the panel reported.
  return secondsLeft ?? Math.ceil(remainingMs / 1000);
}
