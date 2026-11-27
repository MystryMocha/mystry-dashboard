/** User-facing server messages: instance backup and restore. Values are English templates with `{name}` placeholders; the Web string tables translate other languages by key. */
export const BACKUPS_MESSAGES = {
  // Backup records and endpoints
  'server.backups.notFound': 'Backup not found.',
  'server.backups.idInvalid': 'Invalid backup ID.',
  'server.backups.invalidParams': 'The restore options contain unsupported fields or are malformed.',
  'server.backups.legacyInstance': 'Migrate this legacy instance to a panel-managed directory before backing it up or restoring it.',
  'server.backups.markerInvalid': "The instance folder's ownership marker doesn't match the panel record, so the files can't be replaced automatically.",
  'server.backups.inUse': 'This backup is being used by a running task. Try again when it finishes.',
  'server.backups.dirInsideManaged': "BACKUP_DIR can't be inside the instances, imports, uploads, or temporary task folder.",
  'server.backups.dirUnsafe': "The backup folder can't be a symbolic link or directory junction.",
  'server.backups.deleteWithInstanceFailed': "The instance was deleted, but its backups couldn't be removed: {reason}. Delete them from the panel's backup folder manually.",

  // Mutually exclusive with start/stop and file operations
  'server.backups.busyBackingUp': 'A backup of this server is in progress. Try again when it finishes.',
  'server.backups.busyRestoring': 'A restore of this server is in progress. Try again when it finishes.',
  'server.backups.lifecycleBusy': "The server is starting or stopping. Wait until it's running or stopped, then try again.",
  'server.backups.restoreRunning': 'Stop the server before restoring a backup.',

  // Backup while running: pause autosave and flush the world
  'server.backups.saveTimeout': "The server didn't confirm that the world was saved within {seconds} seconds, so the backup was cancelled. Stop the server and try again.",
  'server.backups.serverStateChanged': 'The server started, stopped, or crashed during the backup, so the backup was cancelled. Try again.',
  'server.backups.commandFailed': "Couldn't send the save command to the server: {reason}",
  'server.backups.fileChanged': "A file changed while it was being backed up: {name}. Stop the server and try again.",
  'server.backups.sourceHasLink': "The server folder contains a symbolic link or directory junction, so it can't be backed up: {name}",
  'server.backups.sourceTooManyEntries': 'The server folder has more than {limit} files and folders, so it exceeds the backup limit.',
  'server.backups.sourceTooLarge': 'The server folder is larger than the backup limit ({limit} bytes).',

  // Task progress
  'server.backups.task.backupQueued': 'Waiting to back up',
  'server.backups.task.restoreQueued': 'Waiting to restore',
  'server.backups.task.scheduledQueued': 'Waiting to run the scheduled backup of {name}',
  'server.backups.progress.saving': 'Saving the world…',
  'server.backups.progress.scanning': 'Listing files…',
  'server.backups.progress.archiving': 'Archiving files ({done}/{total})…',
  'server.backups.progress.backingUpCurrent': 'Backing up the current files first…',
  'server.backups.progress.extracting': 'Checking and unpacking files ({done}/{total})…',
  'server.backups.progress.replacing': 'Replacing the server files…',

  // Restore
  'server.backups.diskSpace': 'Not enough disk space. The restore needs about {needed} bytes, but only {available} bytes are free.',
  'server.backups.replaceFailed': 'Replacing the server files failed, so the original files were put back: {reason}',
  'server.backups.rollbackFailed': "Replacing the server files failed and the original files couldn't be put back automatically. They're kept in {path}.",

  // Scheduled backups
  'server.backups.schedule.invalidParams': 'The scheduled backup settings contain unsupported fields or are malformed.',
  'server.backups.schedule.runFailed': 'The scheduled backup of {name} failed: {reason}',
  'server.backups.schedule.diskSpace': 'Not enough disk space. The scheduled backup needs about {needed} bytes, but only {available} bytes are free.',

  // Upload
  'server.backups.upload.missing': 'Choose a backup file to upload.',
  'server.backups.upload.tooLarge': 'The backup file exceeds the upload limit ({limit} bytes). Raise MAX_BACKUP_UPLOAD_BYTES to upload larger backups.',

  // Archive validation
  'server.backups.archive.corrupted': "The backup file is damaged or isn't a Mystry Dashboard backup.",
  'server.backups.archive.manifestMissing': "The backup file has no manifest, so it can't be checked.",
  'server.backups.archive.manifestInvalid': 'The backup manifest is damaged.',
  'server.backups.archive.versionUnsupported': 'This backup format (version {version}) is not supported by this panel version.',
  'server.backups.archive.unsafePath': 'The backup contains an unsafe path: {name}',
  'server.backups.archive.unsupportedEntry': 'The backup contains a link or special file, which is not allowed: {name}',
  'server.backups.archive.reservedPath': 'The backup contains a file the panel manages itself: {name}',
  'server.backups.archive.duplicateEntry': 'The backup contains the same path more than once: {name}',
  'server.backups.archive.checksumMismatch': "A file in the backup doesn't match its recorded checksum: {name}",
  'server.backups.archive.fileMissing': 'The backup is missing a file listed in its manifest: {name}',
  'server.backups.archive.unexpectedFile': "The backup contains a file that isn't listed in its manifest: {name}",
  'server.backups.archive.tooManyEntries': 'The backup contains more than {limit} files and folders.',
  'server.backups.archive.tooLarge': 'The backup contents exceed the size limit ({limit} bytes).',
} as const satisfies Record<string, string>;
