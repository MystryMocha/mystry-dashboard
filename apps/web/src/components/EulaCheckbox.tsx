const MINECRAFT_EULA_URL = 'https://aka.ms/MinecraftEULA';

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
  return (
    <label className="checkbox-field">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>
        我已阅读并同意{' '}
        <a href={MINECRAFT_EULA_URL} target="_blank" rel="noreferrer" style={{ color: 'var(--accent)' }}>
          Minecraft EULA
        </a>
        （面板会据此写入 eula.txt）
      </span>
    </label>
  );
}
