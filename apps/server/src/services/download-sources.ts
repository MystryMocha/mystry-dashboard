import {
  DOWNLOAD_SOURCE_ENUM,
  type DownloadSource,
  type PanelMessage,
} from '@mystry/shared';
import { getDb } from '../db.js';
import { isPanelError, PanelError } from '../utils/errors.js';

const SETTING_KEY = 'download_source';

/** Only official servers are contacted by default: third-party mirrors must be chosen by the user. */
export const DEFAULT_DOWNLOAD_SOURCE: DownloadSource = 'official';

const BMCLAPI_ORIGIN = 'https://bmclapi2.bangbang93.com';
export const BMCLAPI_LABEL = 'BMCLAPI';

/** Only the paths of these official repositories map one-to-one to BMCLAPI /maven; other URLs are not rewritten. */
const MAVEN_PREFIXES = [
  'https://libraries.minecraft.net/',
  'https://maven.minecraftforge.net/',
  'https://maven.neoforged.net/releases/',
];

const MOJANG_HOSTS = new Set([
  'launchermeta.mojang.com',
  'launcher.mojang.com',
  'piston-meta.mojang.com',
  'piston-data.mojang.com',
]);

/** Public GitHub proxies whose operators the panel does not control; content is guaranteed by the pinned SHA-256, so this affects only speed and availability. */
const GITHUB_PROXIES = [
  { label: 'ghfast.top', prefix: 'https://ghfast.top/' },
  { label: 'gh-proxy.com', prefix: 'https://gh-proxy.com/' },
];

/** The Nanjing University mirror syncs only the latest version of some projects; after a version bump it 404s here and the next source takes over. */
const NJU_RELEASE_REPOS = new Set(['fatedier/frp']);

export type ExpectedDigest = { algorithm: 'sha1' | 'sha256'; hex: string };

export type DownloadCandidate = {
  /** Source names shown to users; all proper nouns, not translated. */
  label: string;
  url: string;
  /** Third-party mirrors: allowed only when the checksum is known. */
  mirror: boolean;
};

export type DownloadPlan = {
  candidates: DownloadCandidate[];
  expected?: ExpectedDigest;
};

export function isDownloadSource(value: unknown): value is DownloadSource {
  return (DOWNLOAD_SOURCE_ENUM as readonly unknown[]).includes(value);
}

export function getDownloadSource(): DownloadSource {
  const row = getDb().prepare('SELECT value FROM panel_settings WHERE key = ?').get(SETTING_KEY) as
    | { value: string }
    | undefined;
  return isDownloadSource(row?.value) ? row.value : DEFAULT_DOWNLOAD_SOURCE;
}

export function setDownloadSource(source: DownloadSource): void {
  getDb().prepare(
    `INSERT INTO panel_settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(SETTING_KEY, source, new Date().toISOString());
}

/**
 * Assembles a download plan. BMCLAPI redirects requests to community nodes, and the operators of public proxies are unknown too,
 * so when the checksum is unknown all mirrors are dropped and only the official URL is kept: the panel does not execute files whose origin cannot be verified.
 */
export function createDownloadPlan(candidates: DownloadCandidate[], expected?: ExpectedDigest): DownloadPlan {
  return { candidates: expected ? candidates : candidates.filter((c) => !c.mirror), expected };
}

export function officialCandidate(label: string, url: string): DownloadCandidate {
  return { label, url, mirror: false };
}

function parseUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/** Whether it is an https URL on Mojang's official servers. The Vanilla manifest may come from a mirror, so the URLs inside must pass this check first. */
export function isMojangUrl(url: string): boolean {
  const parsed = parseUrl(url);
  return parsed?.protocol === 'https:' && MOJANG_HOSTS.has(parsed.hostname);
}

/** Mojang metadata and files keep the same path on BMCLAPI with only the domain changed; returns null for other URLs. */
export function mojangMirrorUrl(url: string): string | null {
  return isMojangUrl(url) ? `${BMCLAPI_ORIGIN}${new URL(url).pathname}` : null;
}

/**
 * When the requested URL is https, the final URL after following redirects must be https too. Node's fetch follows redirects that downgrade to http,
 * and a file without a checksum can be replaced on a plaintext link. Mirrors redirecting to community nodes (https) are unaffected.
 * A hand-built Response (test stub) has no url and is treated by the request URL; a rejected response has its body released before throwing.
 */
export async function rejectInsecureRedirect(requestUrl: string, response: Response): Promise<void> {
  if (parseUrl(requestUrl)?.protocol !== 'https:') return;
  if (parseUrl(response.url || requestUrl)?.protocol === 'https:') return;
  try {
    await response.body?.cancel();
  } catch {
    /* Ignore body cleanup failures */
  }
  throw new PanelError('server.system.downloadInsecureRedirect');
}

/** Converts an official Maven file URL to a BMCLAPI /maven URL; returns null when it is not in a known repository. */
export function mavenMirrorUrl(url: string): string | null {
  const prefix = MAVEN_PREFIXES.find((candidate) => url.startsWith(candidate));
  return prefix ? `${BMCLAPI_ORIGIN}/maven/${url.slice(prefix.length)}` : null;
}

export function bmclapiUrl(pathname: string): string {
  return `${BMCLAPI_ORIGIN}${pathname}`;
}

/** Puts the mirror URL before the official URL (when there is a mirror and the China source is selected). */
export function withMirror(
  source: DownloadSource,
  official: DownloadCandidate,
  mirrorUrl: string | null,
): DownloadCandidate[] {
  if (source !== 'china' || !mirrorUrl) return [official];
  return [{ label: BMCLAPI_LABEL, url: mirrorUrl, mirror: true }, official];
}

/** Download sources for a GitHub Release file: the China source tries the mirror and the proxies in turn, and finally falls back to github.com. */
export function githubReleaseCandidates(
  source: DownloadSource,
  repo: string,
  tag: string,
  asset: string,
): DownloadCandidate[] {
  const official = `https://github.com/${repo}/releases/download/${tag}/${asset}`;
  const candidates: DownloadCandidate[] = [];
  if (source === 'china') {
    if (NJU_RELEASE_REPOS.has(repo)) {
      candidates.push({
        label: 'NJU Mirror',
        url: `https://mirror.nju.edu.cn/github-release/${repo}/${tag}/${asset}`,
        mirror: true,
      });
    }
    for (const proxy of GITHUB_PROXIES) {
      candidates.push({ label: proxy.label, url: `${proxy.prefix}${official}`, mirror: true });
    }
  }
  candidates.push(officialCandidate('GitHub', official));
  return candidates;
}

export type SourceFailure = { source: string; error: unknown };

/** Failure reason of a single source, summarized as a phrase without a period; the downloadAttempt template adds punctuation. */
function failureReason(error: unknown): PanelMessage {
  if (isPanelError(error)) {
    switch (error.messageKey) {
      case 'server.deploy.downloadHttpFailed':
      case 'server.deploy.metadataHttpFailed':
        return { key: 'server.system.downloadReasonHttp', params: { status: error.params?.status ?? 0 } };
      case 'server.deploy.downloadTimeout':
      case 'server.deploy.metadataTimeout':
        return { key: 'server.system.downloadReasonTimeout' };
      case 'server.system.downloadChecksumMismatch':
        return { key: 'server.system.downloadReasonChecksum' };
      case 'server.deploy.downloadTooLarge':
      case 'server.deploy.metadataTooLarge':
        return { key: 'server.system.downloadReasonTooLarge' };
      case 'server.system.downloadInsecureRedirect':
        return { key: 'server.system.downloadReasonInsecure' };
      default:
        return { key: 'server.system.downloadReasonInvalid' };
    }
  }
  if (error instanceof SyntaxError || (error instanceof TypeError && !isFetchFailure(error))) {
    return { key: 'server.system.downloadReasonInvalid' };
  }
  return { key: 'server.system.downloadReasonNetwork' };
}

/** Node's fetch throws TypeError('fetch failed') on a connection failure, which has to be told apart from a TypeError while parsing the response. */
function isFetchFailure(error: TypeError): boolean {
  return error.message === 'fetch failed';
}

/** Chains the failures of each source into one nested message, so the reason in each part can be translated by Web. */
export function describeFailures(failures: SourceFailure[]): PanelMessage | '' {
  return failures.reduceRight<PanelMessage | ''>(
    (next, failure) => ({
      key: 'server.system.downloadAttempt',
      params: { source: failure.source, reason: failureReason(failure.error), next },
    }),
    '',
  );
}
