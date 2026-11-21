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
    throw new Error(`面板日志为空：${logPath}`);
  }
  return lines.at(-1);
}

/** Looks only at the real content of the log, not at the logs command's own heading text. */
export function assertLogsShowLine(logsOutput, expectedLine) {
  if (!logsOutput.includes(expectedLine)) {
    throw new Error(`日志命令未返回面板输出，缺少：${expectedLine}\n实际输出：\n${logsOutput}`);
  }
}

// The separator and password line mystryctl shows with the account and password (both UI languages count).
// Unit tests verify with the controller's real terminal output that it is recognized here, so a format change fails there first.
const CREDENTIAL_DIVIDER = /^={64}\r?$/m;
const PASSWORD_LINE = /^[ \t]*(?:Password:|密码：)/m;

/**
 * The admin password must not be written when output is not a terminal (D-027). Only the password block's markers are recognized, without comparing the password itself;
 * on failure the content is not echoed either, to avoid printing a password that might be there once more.
 */
export function assertNoCredentialsShown(content, source) {
  if (CREDENTIAL_DIVIDER.test(content) || PASSWORD_LINE.test(content)) {
    throw new Error(`${source} 写出了管理员密码块；非终端输出和日志文件不得包含密码`);
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
    throw new Error(`面板日志没有记录对照请求 ${controlPath}，无法确认 ${forbiddenPath} 未被请求`);
  }
  if (paths.has(forbiddenPath)) {
    throw new Error(`面板日志显示 ${forbiddenPath} 被请求过`);
  }
}
