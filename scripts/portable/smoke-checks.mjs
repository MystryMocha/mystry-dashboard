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
