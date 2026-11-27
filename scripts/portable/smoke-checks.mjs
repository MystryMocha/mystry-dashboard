import fs from 'node:fs';

/**
 * The release smoke test accepts only language-independent evidence: exit codes, files, HTTP and log content.
 * The UI language decides only the wording of prompts, and must not decide whether a release passes.
 */

/** Takes the last non-empty line of the log, as the sample the logs command must display. */
export function lastLogLine(logPath) {
  const lines = fs.existsSync(logPath)
    ? fs.readFileSync(logPath, 'utf8').split(/\r?\n/).filter((line) => line.trim())
    : [];
  if (lines.length === 0) {
    throw new Error(`The panel log is empty: ${logPath}`);
  }
  return lines.at(-1);
}

/** Looks only at the real content of the log, not at the logs command's own heading text. */
export function assertLogsShowLine(logsOutput, expectedLine) {
  if (!logsOutput.includes(expectedLine)) {
    throw new Error(`The logs command did not return panel output; missing: ${expectedLine}\nActual output:\n${logsOutput}`);
  }
}

// The separator and password line mdash shows with the account and password (both UI languages count).
// Unit tests verify with the controller's real terminal output that it is recognized here, so a format change fails there first.
const CREDENTIAL_DIVIDER = /^={64}\r?$/m;
const PASSWORD_LINE = /^[ \t]*(?:Password:|密码：)/m;

/**
 * The admin password must not be written when output is not a terminal. Only the password block's markers are recognized, without comparing the password itself;
 * on failure the content is not echoed either, to avoid printing a password that might be there once more.
 */
export function assertNoCredentialsShown(content, source) {
  if (CREDENTIAL_DIVIDER.test(content) || PASSWORD_LINE.test(content)) {
    throw new Error(`${source} wrote the admin password block; non-terminal output and log files must not contain the password`);
  }
}

/** Extracts the request path (without query parameters) from a server JSON request log. */
export function loggedRequestPaths(content) {
  const paths = new Set();
  for (const line of content.split(/\r?\n/)) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const url = entry?.req?.url;
    if (typeof url === 'string') paths.add(url.split('?')[0]);
  }
  return paths;
}

/**
 * Proves that an endpoint was never requested. The control path must appear in the log:
 * when the server keeps no request log, "not seen" does not show "not requested", and that case fails outright.
 */
export function assertRequestNotLogged(content, forbiddenPath, controlPath) {
  const paths = loggedRequestPaths(content);
  if (!paths.has(controlPath)) {
    throw new Error(`The panel log has no record of the control request ${controlPath}, so it cannot be confirmed that ${forbiddenPath} was not requested`);
  }
  if (paths.has(forbiddenPath)) {
    throw new Error(`The panel log shows ${forbiddenPath} was requested`);
  }
}

/** Verifies every entry in `tar --numeric-owner -tvzf` output is owned by 0/0 (root). */
export function assertTarEntriesOwnedByRoot(listing) {
  const lines = listing.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) {
    throw new Error('The tar archive listing is empty');
  }
  for (const line of lines) {
    const fields = line.split(/\s+/);
    if (fields.length < 2 || fields[1] !== '0/0') {
      throw new Error(`Expected numeric owner 0/0 in tar archive, got: ${line}`);
    }
  }
}
