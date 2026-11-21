import { spawnSync } from 'node:child_process';

const npmCommand = process.platform === 'win32'
  ? process.env.ComSpec || 'cmd.exe'
  : 'npm';
const npmArguments = process.platform === 'win32'
  ? [
      '/d',
      '/s',
      '/c',
      'npm.cmd audit --omit=dev --json --registry=https://registry.npmjs.org',
    ]
  : ['audit', '--omit=dev', '--json', '--registry=https://registry.npmjs.org'];
const result = spawnSync(
  npmCommand,
  npmArguments,
  {
    cwd: process.cwd(),
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  },
);

if (result.error) {
  console.error(`Could not run npm audit: ${result.error.message}`);
  process.exit(1);
}

let report;
try {
  report = JSON.parse(result.stdout);
} catch {
  console.error(result.stderr || result.stdout || 'npm audit did not return valid JSON');
  process.exit(1);
}

if (!report?.metadata?.vulnerabilities) {
  console.error(report?.error?.summary || 'The npm audit report has no vulnerability counts');
  process.exit(1);
}

const counts = report.metadata.vulnerabilities;
console.log(
  `Production dependency audit: critical=${counts.critical ?? 0}, high=${counts.high ?? 0}, `
    + `moderate=${counts.moderate ?? 0}, low=${counts.low ?? 0}`,
);

if ((counts.critical ?? 0) > 0 || (counts.high ?? 0) > 0) {
  console.error('There are unresolved high/critical production dependency vulnerabilities; a public portable package must not be built.');
  process.exit(1);
}

if ((counts.moderate ?? 0) > 0 || (counts.low ?? 0) > 0) {
  console.warn('Moderate/low advisories remain; the release notes must record them, and dependencies must be upgraded once fixed versions are available.');
}
