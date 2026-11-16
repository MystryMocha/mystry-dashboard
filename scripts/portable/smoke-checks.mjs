import fs from 'node:fs';

/**
 * 发布冒烟只认与语言无关的证据：退出码、文件、HTTP 和日志内容。
 * 界面语言只决定提示文字，不能决定发布能否通过。
 */

/** 取日志里最后一行非空内容，作为 logs 命令必须显示的样本。 */
export function lastLogLine(logPath) {
  const lines = fs.existsSync(logPath)
    ? fs.readFileSync(logPath, 'utf8').split(/\r?\n/).filter((line) => line.trim())
    : [];
  if (lines.length === 0) {
    throw new Error(`面板日志为空：${logPath}`);
  }
  return lines.at(-1);
}

/** 只看日志里的真实内容，不看 logs 命令自己的标题文字。 */
export function assertLogsShowLine(logsOutput, expectedLine) {
  if (!logsOutput.includes(expectedLine)) {
    throw new Error(`日志命令未返回面板输出，缺少：${expectedLine}\n实际输出：\n${logsOutput}`);
  }
}

// mystryctl 显示账号密码时的分隔线和密码行（两种界面语言都算）。
// 单元测试用控制器的真实终端输出验证这里能认出来，格式改了会先在那里失败。
const CREDENTIAL_DIVIDER = /^={64}\r?$/m;
const PASSWORD_LINE = /^[ \t]*(?:Password:|密码：)/m;

/**
 * 输出不是终端时不得写出管理员密码。只认密码块的标记，不比对密码本身；
 * 出错时也不回显内容，避免把可能存在的密码再打印一遍。
 */
export function assertNoCredentialsShown(content, source) {
  if (CREDENTIAL_DIVIDER.test(content) || PASSWORD_LINE.test(content)) {
    throw new Error(`${source} 写出了管理员密码块；非终端输出和日志文件不得包含密码`);
  }
}

/** 从服务端 JSON 请求日志中取出请求路径（去掉查询参数）。 */
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
 * 证明某个接口没有被请求过。对照路径必须出现在日志里：
 * 服务端不记请求日志时「没看到」不能说明「没请求」，这时直接判失败。
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
