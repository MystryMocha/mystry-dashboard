import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Copy, X } from 'lucide-react';
import { copyText } from '../clipboard';
import { useI18n } from '../i18n';

const GUIDE_KEY = 'mystry_multiplayer_guide';

/** 指引栏开关只是本机浏览器的偏好；存储不可用（隐私模式等）时按默认展开处理。 */
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
      // 记不住也不影响本次使用
    }
  }
  return [open, change] as const;
}

/**
 * 页面最上面的总开关「对玩家开放这个实例」：点了立即保存，不再是「勾选 + 保存」两步。
 * checked 必须来自服务端状态，保存失败时开关自然回到原位。关闭时不显示状态，免得和开关重复。
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

/** 「让玩家加入」的步骤列表：编号是真实的先后顺序，每步一句话，操作按钮跟在那一步下面。 */
export function JoinSteps({ steps }: { steps: ReactNode[] }) {
  const { t } = useI18n();
  // 只有一步（frp 公网端口）时不编号，一个「1」没有顺序可言。
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

/** 复制之类的结果就近显示在按钮下面，几秒后自己消失；手机上页面顶部的提示看不到。 */
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

/** 就近提示：没有内容时也保留空的 role="status"，读屏才会播报后来填进去的文字。 */
export function FlashNote({ text }: { text: string }) {
  return <p className={text ? 'field-help' : 'visually-hidden'} role="status">{text}</p>;
}

/** 最后一步：玩家在 Minecraft 里连的地址；还没有地址（服务器没在运行）时只说什么时候会有。 */
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
  /** 重新打开指引时把焦点放回关闭按钮。 */
  closeRef?: RefObject<HTMLButtonElement | null>;
}

/**
 * 联机三种方式共用的两栏：左边按「开关 → 让玩家加入 → 高级设置」排，右边是出问题时才看的指引（排查、模式说明）。
 * 指引栏沿用一键部署页的 deploy-layout / deploy-guide，≤1180px 时落到主栏下方；关闭后主栏占满。
 * 加入步骤和不做就一定连不上的前提（先启动服务器、Windows 管理员身份、密钥只发给玩家）留在主栏，不放这里。
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
