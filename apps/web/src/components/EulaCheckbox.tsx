import { useI18n } from '../i18n';

export const MINECRAFT_EULA_URL = 'https://aka.ms/MinecraftEULA';

/** The EULA acceptance checkbox shared by deploy, import, empty instance and instance settings; unchecked by default, and the user must accept it themselves. */
export function EulaCheckbox({
  checked,
  disabled,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  const { rich } = useI18n();
  return (
    <label className="checkbox-field">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>
        {rich('eula.agree', {
          link: (chunk) => (
            <a href={MINECRAFT_EULA_URL} target="_blank" rel="noreferrer" className="link">
              {chunk}
            </a>
          ),
        })}
      </span>
    </label>
  );
}
