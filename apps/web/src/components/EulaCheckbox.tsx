import { useI18n } from '../i18n';

export const MINECRAFT_EULA_URL = 'https://aka.ms/MinecraftEULA';

/** 部署、导入、空实例和实例设置共用的 EULA 同意勾选框；默认不勾选，必须由用户主动同意。 */
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
