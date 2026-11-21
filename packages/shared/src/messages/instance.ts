/** User-facing server messages: instances, processes, console and Java runtimes. Values are English templates with `{name}` placeholders; the Web string tables translate other languages by key. */
export const INSTANCE_MESSAGES = {
  // Instance endpoints
  'server.instance.notFound': 'Instance not found.',
  'server.instance.invalidParams': 'The instance parameters contain unsupported fields or are malformed.',
  'server.instance.nameRequired': 'The name cannot be empty.',
  'server.instance.commandInvalid': 'The command is too long, empty, or contains unsupported fields.',

  // Create, register, delete and take over
  'server.instance.javaRuntimeInvalid': 'The selected Java runtime does not exist or is unavailable. Rescan and select again.',
  'server.instance.selectedNodeNotFound': 'The selected node does not exist.',
  'server.instance.remoteNodeUnsupported': 'This version does not support creating instances on remote nodes.',
  'server.instance.createDbFailed': 'Failed to create the instance: the database did not record it.',
  'server.instance.defaultDirNotEmpty': 'The default instance directory must be empty. Taking over an existing directory is not allowed.',
  'server.instance.createDirFailed': 'Cannot create or write to the install directory: {dir} ({reason}).',
  'server.instance.registerDirMissing': 'The instance directory does not exist, so the instance cannot be registered.',
  'server.instance.registerDirEmpty': 'The instance directory is empty, so the instance cannot be registered.',
  'server.instance.deleteRunning': 'Stop the instance before deleting it.',
  'server.instance.deleteDbFailed': 'Failed to delete the instance: the database record was not removed.',
  'server.instance.adoptRunning': 'Stop the instance before completing the migration.',
  'server.instance.adoptAlreadyManaged': 'This instance is already in the panel data directory. No migration is needed.',
  'server.instance.adoptDirEmpty': 'The default instance directory cannot be empty.',
  'server.instance.adoptDirFailed': 'The migration couldn\'t be completed: {reason}',
  'server.instance.adoptMarkerInvalid': 'The migration couldn\'t be completed: the panel marker file in the instance folder is invalid or belongs to another instance.',
  'server.instance.adoptStateChanged': 'The migration failed because the instance state changed. Try again.',
  'server.instance.propertiesNotRegularFile': 'server.properties is not a regular file.',

  // Process start and stop
  'server.instance.startShuttingDown': 'The panel is shutting down, so the instance cannot be started.',
  'server.instance.startCancelledShuttingDown': 'The panel is shutting down. The start was cancelled.',
  'server.instance.alreadyRunning': 'The instance is already running, starting, or stopping.',
  'server.instance.forgeArgsMissing': 'Forge/NeoForge launch arguments file not found: {path}. Redeploy the instance.',
  'server.instance.modloaderNotInstalled': 'Forge/NeoForge installation has not finished. Redeploy the instance, or check the Task Center for why the installation failed.',
  'server.instance.jarMissing': 'Server jar not found: {jar}.',
  'server.instance.notRunning': 'The instance is not running.',
  'server.instance.stillStarting': 'The instance is starting. Try again later.',
  'server.instance.stopPending': 'The instance is still stopping. Wait, or force stop it.',
  'server.instance.forceStopPending': 'The instance is still being force stopped. Please wait.',
  'server.instance.stopStdinUnavailable': 'The instance input stream is unavailable, so the stop command cannot be sent.',
  'server.instance.stopWriteFailed': 'Failed to write the stop command.',
  'server.instance.forgetRunning': 'Process state cannot be cleared while the instance is running.',

  // Console commands
  'server.instance.commandNotRunning': 'The instance is not running, so the command cannot be sent.',
  'server.instance.commandEmpty': 'The command cannot be empty.',
  'server.instance.commandControlChars': 'The command cannot contain line breaks or control characters.',
  'server.instance.commandTooLarge': 'The command exceeds the size limit ({limit} bytes).',
  'server.instance.stdinBusy': 'The console input buffer is busy. Try again later.',
  'server.instance.stdinUnavailable': 'The instance input stream is unavailable.',
  'server.instance.stdinTooLarge': 'The console input buffer exceeds the size limit ({limit} bytes).',
  'server.instance.commandWriteFailed': 'Failed to write the command. The instance input stream is unavailable.',

  // Console connection
  'server.instance.consoleTicketLimit': 'Too many console connection requests. Try again later.',
  'server.instance.consoleTicketMissing': 'The console connection is missing its credentials. Refresh the page and try again.',
  'server.instance.consoleTicketInvalid': 'The console connection credentials are invalid or have expired. Refresh the page and try again.',
  'server.instance.consoleMessageTooLarge': 'The console message exceeds the size limit ({limit} bytes).',
  'server.instance.consoleCommandRateLimited': 'Commands are being sent too often. Try again later.',

  // Panel notices written to the console log (the prefix matches Web's English console.prefix.panel; Web rewrites the whole line in the current language)
  'server.instance.consoleProcessStartFailed': '[Panel] Process failed to start: {reason}',
  'server.instance.consoleProcessExited': '[Panel] Process exited (exit code {code}, signal {signal})',
  'server.instance.consoleNone': 'none',

  // Java runtimes
  'server.instance.javaRuntimeUnavailable': 'The selected Java runtime is unavailable. Rescan and select again.',
  'server.instance.javaRuntimeFileMissing': 'Java runtime file not found: {path}. Rescan and select again.',
  'server.instance.javaRuntimePathUnresolved': 'Cannot resolve the Java runtime path: {path}. Rescan and select again.',
  'server.instance.javaRuntimePathChanged': 'The Java runtime path has changed. Rescan and select again.',
  'server.instance.javaRuntimeVerifyFailed': 'The selected Java runtime failed verification. Rescan and select again.',
} as const satisfies Record<string, string>;
