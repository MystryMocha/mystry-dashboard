import {
  DOWNLOAD_SOURCE_ENUM,
  type DownloadSource,
  type PanelMessage,
} from '@mystry/shared';
import { getDb } from '../db.js';
import { isPanelError } from '../utils/errors.js';

const SETTING_KEY = 'download_source';

/** 默认只连官方服务器：第三方镜像必须由用户主动选择。 */
export const DEFAULT_DOWNLOAD_SOURCE: DownloadSource = 'official';

const BMCLAPI_ORIGIN = 'https://bmclapi2.bangbang93.com';
export const BMCLAPI_LABEL = 'BMCLAPI';

/** 只有这些官方仓库的路径与 BMCLAPI /maven 一一对应，其他地址不改写。 */
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

/** 公共 GitHub 代理，运营方不受面板控制；内容靠钉死的 SHA-256 保证，这里只影响速度和可用性。 */
const GITHUB_PROXIES = [
  { label: 'ghfast.top', prefix: 'https://ghfast.top/' },
  { label: 'gh-proxy.com', prefix: 'https://gh-proxy.com/' },
];

/** 南京大学镜像只同步部分项目的最新版本；版本更新后这里会 404，由下一个来源接手。 */
const NJU_RELEASE_REPOS = new Set(['fatedier/frp']);

export type ExpectedDigest = { algorithm: 'sha1' | 'sha256'; hex: string };

export type DownloadCandidate = {
  /** 显示给用户的来源名，均为专有名词，不翻译。 */
  label: string;
  url: string;
  /** 第三方镜像：只有已知校验值时才允许使用。 */
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
 * 组装下载计划。BMCLAPI 会把请求转到社区节点，公共代理的运营方也不可知，
 * 所以校验值未知时一律丢弃镜像，只留官方地址：面板不执行来路无法核对的文件。
 */
export function createDownloadPlan(candidates: DownloadCandidate[], expected?: ExpectedDigest): DownloadPlan {
  return { candidates: expected ? candidates : candidates.filter((c) => !c.mirror), expected };
}

export function officialCandidate(label: string, url: string): DownloadCandidate {
  return { label, url, mirror: false };
}

/** Mojang 元数据和文件在 BMCLAPI 上路径不变，只换域名；其他地址返回 null。 */
export function mojangMirrorUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || !MOJANG_HOSTS.has(parsed.hostname)) return null;
    return `${BMCLAPI_ORIGIN}${parsed.pathname}`;
  } catch {
    return null;
  }
}

/** 把官方 Maven 文件地址转成 BMCLAPI /maven 地址；不在已知仓库内返回 null。 */
export function mavenMirrorUrl(url: string): string | null {
  const prefix = MAVEN_PREFIXES.find((candidate) => url.startsWith(candidate));
  return prefix ? `${BMCLAPI_ORIGIN}/maven/${url.slice(prefix.length)}` : null;
}

export function bmclapiUrl(pathname: string): string {
  return `${BMCLAPI_ORIGIN}${pathname}`;
}

/** 官方地址前面加上镜像地址（有镜像且选了国内来源时）。 */
export function withMirror(
  source: DownloadSource,
  official: DownloadCandidate,
  mirrorUrl: string | null,
): DownloadCandidate[] {
  if (source !== 'china' || !mirrorUrl) return [official];
  return [{ label: BMCLAPI_LABEL, url: mirrorUrl, mirror: true }, official];
}

/** GitHub Release 文件的下载来源：国内来源依次试镜像和代理，最后回到 github.com。 */
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

/** 单个来源的失败原因，归纳成不带句号的短语，由 downloadAttempt 模板补标点。 */
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
      default:
        return { key: 'server.system.downloadReasonInvalid' };
    }
  }
  if (error instanceof SyntaxError || (error instanceof TypeError && !isFetchFailure(error))) {
    return { key: 'server.system.downloadReasonInvalid' };
  }
  return { key: 'server.system.downloadReasonNetwork' };
}

/** Node 的 fetch 在连接失败时抛 TypeError('fetch failed')，要和解析响应时的 TypeError 分开。 */
function isFetchFailure(error: TypeError): boolean {
  return error.message === 'fetch failed';
}

/** 把各来源的失败串成一条嵌套消息，这样每一段的原因都能被 Web 翻译。 */
export function describeFailures(failures: SourceFailure[]): PanelMessage | '' {
  return failures.reduceRight<PanelMessage | ''>(
    (next, failure) => ({
      key: 'server.system.downloadAttempt',
      params: { source: failure.source, reason: failureReason(failure.error), next },
    }),
    '',
  );
}
