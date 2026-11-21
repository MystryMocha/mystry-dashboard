/** User-facing server messages: JVM argument parsing and diagnostics. Values are English templates with `{name}` placeholders; the Web string tables translate other languages by key. */
export const JVM_MESSAGES = {
  // Diagnostics: the key name is issue.code in camelCase; parse errors (PARSE_ERROR / ARGFILE_PARSE_ERROR) use the key given by the parser
  'server.jvm.issue.argsTooLong': "JVM arguments can't exceed {max} characters.",
  'server.jvm.issue.unclosedQuote': 'JVM arguments contain an unclosed quote.',
  'server.jvm.issue.xmsCount': 'JVM arguments must include exactly one -Xms initial memory argument.',
  'server.jvm.issue.xmxCount': 'JVM arguments must include exactly one -Xmx max memory argument.',
  'server.jvm.issue.xmsFormat': 'The initial memory format is invalid. Use a value like -Xms1G or -Xms1024M.',
  'server.jvm.issue.xmxFormat': 'The max memory format is invalid. Use a value like -Xmx4G or -Xmx4096M.',
  'server.jvm.issue.memoryOrder': "Initial memory can't be greater than max memory.",
  'server.jvm.issue.memoryHigh': 'Max memory is close to or above what this host can safely allocate. Leave memory for the system and the panel.',
  'server.jvm.issue.panelOwnedArgument': "The panel manages {argument}. You can't add it to JVM arguments.",
  'server.jvm.issue.gcConflict': "GC arguments can't repeat, and you can choose only one garbage collector.",
  'server.jvm.issue.presetCoreMismatch': '{preset} only works with {cores} cores.',
  'server.jvm.issue.javaMajorUnknown': "We haven't confirmed that {preset} works with the selected Java version.",
  'server.jvm.issue.presetJavaMismatch': "{preset} isn't verified on Java {java}.",
  'server.jvm.issue.paperMemoryMismatch': 'The Paper Aikar preset requires Xms and Xmx to match.',
  'server.jvm.issue.paperMemoryLow': 'PaperMC recommends at least 6 GiB of memory for Aikar flags.',

  // Java installed automatically by the panel (Eclipse Temurin JRE)
  'server.jvm.javaInstall.queued': 'Waiting to install Java {major}',
  'server.jvm.javaInstall.downloading': 'Downloading Java {major}',
  'server.jvm.javaInstall.extracting': 'Extracting Java {major}',
  'server.jvm.javaInstall.verifying': 'Checking Java {major}',
  'server.jvm.javaInstall.unsupportedMajor': "The panel can't install Java {major} automatically.",
  'server.jvm.javaInstall.platformUnsupported': "The panel can't install Java automatically on this system. Download and install Java yourself, then select Rescan.",
  'server.jvm.javaInstall.downloadFailed': "Java {major} couldn't be downloaded. If GitHub is slow or blocked here, switch the download source to the China mirror and try again, or download and install Java yourself.",
  'server.jvm.javaInstall.checksumMismatch': 'The downloaded Java {major} failed the checksum check and was discarded.',
  'server.jvm.javaInstall.extractFailed': "The Java {major} archive couldn't be extracted.",
  'server.jvm.javaInstall.verifyFailed': "The installed Java {major} didn't run correctly, so it wasn't added.",
  'server.jvm.javaInstall.notCancellable': 'This Java installation has already finished, so it can\'t be cancelled.',

  // Preset names: used as the nested {preset} param in diagnostics
  'server.jvm.preset.compatibility': 'Compatibility First',
  'server.jvm.preset.g1Balanced': 'G1 Balanced',
  'server.jvm.preset.paperAikar': 'Paper Aikar',
} as const satisfies Record<string, string>;
