import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Copy, X } from 'lucide-react';
import { copyText } from '../clipboard';
import { useI18n } from '../i18n';

const GUIDE_KEY = 'mystry_multiplayer_guide';

/** The guide column's open/closed state is only a preference in the local browser; when storage is unavailable (private mode, etc.) it is treated as expanded by default. */
export function useGuideOpen() {
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(GUIDE_KEY) !== 'closed';
    } catch {
      return true;
    }
  });
  function change(next: boolean) {
    setOpen(next);
    try {
      if (next) localStorage.removeItem(GUIDE_KEY);
      else localStorage.setItem(GUIDE_KEY, 'closed');
    } catch {
      // Failing to remember it does not affect this use
    }
  }
  return [open, change] as const;
}

/**
 * The master switch at the very top of the page, "Open this instance to players": it saves immediately on click, no longer the two steps of "check + save".
 * checked must come from server state, so on a save failure the switch naturally returns to its place. No status is shown while off, to avoid repeating the switch.
 */
export function OpenSwitch({
  checked,
  disabled,
  status,
  description,
  onChange,
}: {
  checked: boolean;
  disabled: boolean;
  status?: ReactNode;
  description?: string;
  onChange: (next: boolean) => void;
}) {
  const { t } = useI18n();
  const titleId = useId();
  const descId = useId();
  return (
    <div className="list-group multiplayer-open">
      <label className="list-row multiplayer-open-row">
        <span className="list-row-text">
          <span className="multiplayer-open-title">
            <span className="list-row-title" id={titleId}>{t('multiplayer.open')}</span>
            {status}
          </span>
          {description && <span className="list-row-desc" id={descId}>{description}</span>}
        </span>
        <input
          type="checkbox"
          role="switch"
          className="switch"
          checked={checked}
          disabled={disabled}
          aria-labelledby={titleId}
          aria-describedby={description ? descId : undefined}
          onChange={(event) => onChange(event.target.checked)}
        />
      </label>
    </div>
  );
}

/** The step list for "let players join": the numbering is the real order, one sentence per step, with the action button right under that step. */
export function JoinSteps({ steps }: { steps: ReactNode[] }) {
  const { t } = useI18n();
  // With only one step (frp public port) there is no numbering; a lone "1" has no order to speak of.
  if (steps.length === 1) {
    return (
      <section className="form-section">
        <h3 className="form-section-title">{t('multiplayer.join.title')}</h3>
        <div className="multiplayer-step multiplayer-step-single">{steps[0]}</div>
      </section>
    );
  }
  return (
    <section className="form-section">
      <h3 className="form-section-title">{t('multiplayer.join.title')}</h3>
      <ol className="multiplayer-steps">
        {steps.map((step, index) => (
          <li key={index}>
            <span className="step-badge" aria-hidden="true">{index + 1}</span>
            <div className="multiplayer-step">{step}</div>
          </li>
        ))}
      </ol>
    </section>
  );
}

/** Results such as a copy are shown close by, below the button, and disappear on their own after a few seconds; on phones a notice at the top of the page would not be seen. */
export function useFlash() {
  const [text, setText] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  function show(next: string) {
    if (timer.current) clearTimeout(timer.current);
    setText(next);
    timer.current = setTimeout(() => setText(''), 4000);
  }
  return [text, show] as const;
}

/** Nearby notice: an empty role="status" is kept even with no content, so screen readers announce text filled in later. */
export function FlashNote({ text }: { text: string }) {
  return <p className={text ? 'field-help' : 'visually-hidden'} role="status">{text}</p>;
}

/** The last step: the address players connect to in Minecraft; when there is no address yet (the server is not running) it only says when there will be one. */
export function JoinAddressStep({ address }: { address: string | null }) {
  const { t } = useI18n();
  const [flash, showFlash] = useFlash();
  if (!address) return <p>{t('multiplayer.join.pending')}</p>;
  return (
    <>
      <p>{t('multiplayer.join.connect')}</p>
      <div className="multiplayer-join-address">
        <code className="direct-address">{address}</code>
        <button
          className="btn btn-sm"
          type="button"
          aria-label={t('multiplayer.direct.copyAria', { address })}
          onClick={() => void copyText(address).then((ok) => showFlash(ok ? t('multiplayer.direct.copied', { address }) : t('multiplayer.direct.copyFailed')))}
        >
          <Copy size={13} aria-hidden="true" />
          {t('action.copy')}
        </button>
      </div>
      <FlashNote text={flash} />
    </>
  );
}

export interface GuideControl {
  open: boolean;
  onClose: () => void;
  /** Puts focus back on the close button when the guide is reopened. */
  closeRef?: RefObject<HTMLButtonElement | null>;
}

/**
 * The two columns shared by the three multiplayer modes: the left is ordered "switch → let players join → advanced settings", and the right is the guide looked at only when something goes wrong (troubleshooting, mode notes).
 * The guide column reuses deploy-layout / deploy-guide from the one-click deploy page, dropping below the main column at ≤1180px; when closed the main column takes the full width.
 * The join steps and the prerequisites without which it can never connect (start the server first, run as Windows admin, give the secret only to players) stay in the main column, not here.
 */
export function MultiplayerLayout({
  guide,
  control,
  children,
}: {
  guide: ReactNode;
  control: GuideControl;
  children: ReactNode;
}) {
  const { t } = useI18n();
  const titleId = useId();
  const showGuide = control.open && Boolean(guide);
  return (
    <div className={`deploy-layout multiplayer-layout${showGuide ? '' : ' is-guide-closed'}`}>
      <div className="form-stack">{children}</div>
      {showGuide && (
        <aside className="card deploy-guide multiplayer-guide" aria-labelledby={titleId}>
          <div className="multiplayer-guide-head">
            <h2 id={titleId}>{t('multiplayer.guide.title')}</h2>
            <button
              ref={control.closeRef}
              className="btn btn-icon btn-plain btn-sm"
              type="button"
              aria-label={t('multiplayer.guide.close')}
              title={t('multiplayer.guide.close')}
              onClick={control.onClose}
            >
              <X size={16} aria-hidden="true" />
            </button>
          </div>
          {guide}
        </aside>
      )}
    </div>
  );
}
