/**
 * Child processes inherit only the environment Java/Minecraft needs, so panel config such as JWT_SECRET and DATA_DIR is not passed to third-party programs.
 */
export function getMinecraftChildEnv(): NodeJS.ProcessEnv {
  const keys = process.platform === 'win32'
    ? [
        'PATH',
        'Path',
        'JAVA_HOME',
        'SystemRoot',
        'WINDIR',
        'ComSpec',
        'PATHEXT',
        'TEMP',
        'TMP',
        'USERPROFILE',
      ]
    : ['PATH', 'JAVA_HOME', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TMPDIR'];
  const env: NodeJS.ProcessEnv = {};
  for (const key of keys) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}
