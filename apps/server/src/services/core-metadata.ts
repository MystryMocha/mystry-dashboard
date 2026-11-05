import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import type { CoreType, DownloadSource } from '@mystry/shared';
import { config } from '../config.js';
import { PanelError, throwIfAborted } from '../utils/errors.js';
import { createTimeoutAbort, USER_AGENT } from './core-utils.js';
import {
  BMCLAPI_LABEL,
  bmclapiUrl,
  createDownloadPlan,
  describeFailures,
  getDownloadSource,
  mavenMirrorUrl,
  mojangMirrorUrl,
  officialCandidate,
  withMirror,
  type DownloadPlan,
  type ExpectedDigest,
  type SourceFailure,
} from './download-sources.js';

type DeployableCore = Exclude<CoreType, 'custom'>;

const MOJANG_MANIFEST_URL = 'https://launchermeta.mojang.com/mc/game/version_manifest_v2.json';
const FORGE_INDEX_URL = 'https://files.minecraftforge.net/net/minecraftforge/forge/maven-metadata.json';
const NEOFORGE_METADATA_URL = 'https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml';
const FABRIC_META_URL = 'https://meta.fabricmc.net';

async function readBoundedResponseText(response: Response): Promise<string> {
  const contentLength = Number(response.headers.get('content-length') || 0);
  if (Number.isFinite(contentLength) && contentLength > config.maxCoreMetadataBytes) {
    throw new PanelError('server.deploy.metadataTooLarge');
  }
  if (!response.body) throw new PanelError('server.deploy.metadataNoBody');

  const nodeStream = Readable.fromWeb(
    response.body as import('stream/web').ReadableStream,
  );
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    for await (const chunk of nodeStream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      bytes += buffer.length;
      if (bytes > config.maxCoreMetadataBytes) {
        nodeStream.destroy();
        throw new PanelError('server.deploy.metadataTooLarge');
      }
      chunks.push(buffer);
    }
  } finally {
    nodeStream.destroy();
  }
  return Buffer.concat(chunks, bytes).toString('utf8');
}

async function fetchMetadataText(url: string, signal?: AbortSignal): Promise<string> {
  throwIfAborted(signal);
  const timeout = createTimeoutAbort(signal, config.coreMetadataTimeoutMs, 'server.deploy.metadataTimeout');

  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: timeout.signal,
    });
    if (!response.ok) {
      try {
        await response.body?.cancel();
      } catch {
        /* 忽略错误响应正文清理失败 */
      }
      throw new PanelError('server.deploy.metadataHttpFailed', { status: response.status, url });
    }
    return await readBoundedResponseText(response);
  } catch (error) {
    throw timeout.errorFor(error);
  } finally {
    timeout.dispose();
  }
}

export async function fetchText(url: string, signal?: AbortSignal): Promise<string> {
  return fetchMetadataText(url, signal);
}

export async function fetchJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const text = await fetchMetadataText(url, signal);
  return JSON.parse(text) as T;
}

/** 一个元数据来源：mirror 为 true 的来源只在选了国内来源时使用，并排在官方之前。 */
type MetadataSource<T> = { label: string; mirror?: boolean; load: () => Promise<T> };

/** 按来源顺序读取元数据，解析也算在内，所以镜像返回异常内容时同样回到官方。 */
async function loadMetadata<T>(
  source: DownloadSource,
  sources: Array<MetadataSource<T>>,
  signal?: AbortSignal,
): Promise<T> {
  const active = source === 'china' ? sources : sources.filter((item) => !item.mirror);
  const failures: SourceFailure[] = [];
  for (const item of active) {
    try {
      return await item.load();
    } catch (error) {
      if (signal?.aborted || active.length === 1) throw error;
      failures.push({ source: item.label, error });
    }
  }
  throw new PanelError('server.system.metadataAllSourcesFailed', { attempts: describeFailures(failures) });
}

/** 镜像列表为空时视为失败，让官方来确认这个版本是否真的没有内容。 */
function requireEntries<T>(entries: T[]): T[] {
  if (!entries.length) throw new TypeError('empty metadata');
  return entries;
}

function parseMavenVersions(xml: string): string[] {
  const matches = [...xml.matchAll(/<version>([^<]+)<\/version>/g)];
  return matches.map((m) => m[1]!).filter(Boolean);
}

/**
 * NeoForge 版本号 → Minecraft 版本。新旧版号靠段数区分，不靠主版本大小：
 * - 三段 `<小版本>.<补丁>.<构建>`：21.1.244 → 1.21.1，21.0.167 → 1.21
 * - 四段 `<年份>.<序号>.<热修>.<构建>`：26.1.2.126 → 26.1.2，26.3.0.101 → 26.3
 * - 快照构建在 `+` 后带快照名：26.1.0.0-alpha.1+snapshot-1 → 26.1-snapshot-1
 * - 愚人节版：0.25w14craftmine.3-beta → 25w14craftmine
 */
export function neoForgeVersionToMc(neoVersion: string): string {
  const special = /^0\.(\d+w\d+\w*)\./.exec(neoVersion);
  if (special) return special[1]!;
  const match = /^(\d+)\.(\d+)\.(\d+)(\.\d+)?(?:-(?:alpha|beta)[^+]*)?(?:\+(.+))?$/.exec(neoVersion);
  if (!match) throw new PanelError('server.deploy.neoforgeVersionInvalid', { version: neoVersion });
  const [, first, second, third, build, snapshot] = match;
  const release = build === undefined
    ? (second === '0' ? `1.${first}` : `1.${first}.${second}`)
    : (third === '0' ? `${first}.${second}` : `${first}.${second}.${third}`);
  return snapshot ? `${release}-${snapshot}` : release;
}

/** Minecraft 正式版的版本号；快照、预发布和愚人节版都不符合。 */
const MC_RELEASE_VERSION = /^\d+\.\d+(?:\.\d+)?$/;

/** 版本号按数字降序，21.0.167 排在 21.0.98-beta 前面。 */
function newestFirst(a: string, b: string): number {
  return b.localeCompare(a, undefined, { numeric: true });
}

type PaperBuild = {
  id: number;
  channel: string;
  downloads?: {
    'server:default'?: { name: string; url: string; checksums?: { sha256?: string } };
  };
};

type MojangManifest = { versions: Array<{ id: string; type: string; url: string; sha1?: string }> };

function loadMojangManifest(source: DownloadSource, signal?: AbortSignal): Promise<MojangManifest> {
  return loadMetadata<MojangManifest>(source, [
    {
      label: BMCLAPI_LABEL,
      mirror: true,
      load: () => fetchJson<MojangManifest>(bmclapiUrl('/mc/game/version_manifest_v2.json'), signal),
    },
    { label: 'Mojang', load: () => fetchJson<MojangManifest>(MOJANG_MANIFEST_URL, signal) },
  ], signal);
}

type FabricVersionEntry = { version: string; stable: boolean };

/** Fabric Meta 的列表接口；BMCLAPI 在 /fabric-meta 下路径相同。 */
function loadFabricMeta<T>(
  source: DownloadSource,
  pathname: string,
  parse: (data: unknown) => T,
  signal?: AbortSignal,
): Promise<T> {
  return loadMetadata<T>(source, [
    {
      label: BMCLAPI_LABEL,
      mirror: true,
      load: async () => parse(await fetchJson(bmclapiUrl(`/fabric-meta${pathname}`), signal)),
    },
    { label: 'FabricMC', load: async () => parse(await fetchJson(`${FABRIC_META_URL}${pathname}`, signal)) },
  ], signal);
}

function loadForgeIndex(signal?: AbortSignal): Promise<Record<string, string[]>> {
  return fetchJson<Record<string, string[]>>(FORGE_INDEX_URL, signal);
}

async function loadNeoForgeVersions(source: DownloadSource, signal?: AbortSignal): Promise<string[]> {
  return loadMetadata<string[]>(source, [
    {
      label: BMCLAPI_LABEL,
      mirror: true,
      load: async () => requireEntries(parseMavenVersions(
        await fetchText(bmclapiUrl('/maven/net/neoforged/neoforge/maven-metadata.xml'), signal),
      )),
    },
    { label: 'NeoForged', load: async () => parseMavenVersions(await fetchText(NEOFORGE_METADATA_URL, signal)) },
  ], signal);
}

function matchesNeoForgeMc(neoVersion: string, mcVersion: string): boolean {
  try {
    return neoForgeVersionToMc(neoVersion) === mcVersion;
  } catch {
    return false;
  }
}

export async function listCoreVersions(
  coreType: DeployableCore,
  signal?: AbortSignal,
  source: DownloadSource = getDownloadSource(),
): Promise<string[]> {
  if (coreType === 'paper') {
    const data = await fetchJson<{ versions: Record<string, string[]> }>(
      'https://fill.papermc.io/v3/projects/paper',
      signal,
    );
    const versions = Object.values(data.versions).flat();
    return versions.filter((v) => !v.includes('-'));
  }

  if (coreType === 'fabric') {
    return loadFabricMeta(
      source,
      '/v2/versions/game',
      (data) => (data as FabricVersionEntry[]).filter((g) => g.stable).map((g) => g.version),
      signal,
    );
  }

  if (coreType === 'forge') {
    const versions = await loadMetadata<string[]>(source, [
      {
        label: BMCLAPI_LABEL,
        mirror: true,
        load: async () => requireEntries(await fetchJson<string[]>(bmclapiUrl('/forge/minecraft'), signal)),
      },
      { label: 'MinecraftForge', load: async () => Object.keys(await loadForgeIndex(signal)) },
    ], signal);
    return [...versions].sort(newestFirst);
  }

  if (coreType === 'neoforge') {
    const mcSet = new Set<string>();
    for (const v of await loadNeoForgeVersions(source, signal)) {
      try {
        const mcVersion = neoForgeVersionToMc(v);
        // 和其他核心一样只列正式版。
        if (MC_RELEASE_VERSION.test(mcVersion)) mcSet.add(mcVersion);
      } catch {
          /* 忽略无法映射到 Minecraft 版本的条目 */
      }
    }
    return [...mcSet].sort(newestFirst);
  }

  // Vanilla
  const manifest = await loadMojangManifest(source, signal);
  return manifest.versions.filter((v) => v.type === 'release').map((v) => v.id);
}

export async function listPaperBuilds(version: string, signal?: AbortSignal): Promise<number[]> {
  const builds = await fetchJson<PaperBuild[]>(
    `https://fill.papermc.io/v3/projects/paper/versions/${version}/builds`,
    signal,
  );
  const stable = builds.filter((b) => b.channel === 'STABLE');
  const list = (stable.length ? stable : builds).map((b) => b.id);
  return list.sort((a, b) => a - b);
}

export async function listFabricLoaders(
  gameVersion: string,
  signal?: AbortSignal,
  source: DownloadSource = getDownloadSource(),
): Promise<string[]> {
  return loadFabricMeta(
    source,
    `/v2/versions/loader/${gameVersion}`,
    (data) => (data as Array<{ loader: { version: string; stable: boolean } }>)
      .filter((x) => x.loader.stable)
      .map((x) => x.loader.version),
    signal,
  );
}

export async function listFabricInstallers(
  signal?: AbortSignal,
  source: DownloadSource = getDownloadSource(),
): Promise<string[]> {
  return loadFabricMeta(
    source,
    '/v2/versions/installer',
    (data) => (data as FabricVersionEntry[]).filter((x) => x.stable).map((x) => x.version),
    signal,
  );
}

type BmclForgeEntry = { version: string; build: number; branch?: string | null };

/** Forge loader 版本列表（不含 MC 前缀），新版本在前。 */
export async function listForgeLoaders(
  mcVersion: string,
  signal?: AbortSignal,
  source: DownloadSource = getDownloadSource(),
): Promise<string[]> {
  return loadMetadata<string[]>(source, [
    {
      label: BMCLAPI_LABEL,
      mirror: true,
      load: async () => {
        const data = await fetchJson<BmclForgeEntry[]>(
          bmclapiUrl(`/forge/minecraft/${encodeURIComponent(mcVersion)}`),
          signal,
        );
        // BMCLAPI 的返回不保证顺序；旧版本的文件名还带分支后缀，要拼回去才能组成下载地址。
        return requireEntries([...data].sort((a, b) => b.build - a.build))
          .map((x) => (x.branch ? `${x.version}-${x.branch}` : x.version));
      },
    },
    {
      label: 'MinecraftForge',
      load: async () => {
        const entries = (await loadForgeIndex(signal))[mcVersion] ?? [];
        return entries.map((entry) => entry.slice(mcVersion.length + 1)).reverse();
      },
    },
  ], signal);
}

/** NeoForge 版本列表（完整 NeoForge 版本号），新版本在前。 */
export async function listNeoForgeLoaders(
  mcVersion: string,
  signal?: AbortSignal,
  source: DownloadSource = getDownloadSource(),
): Promise<string[]> {
  return loadMetadata<string[]>(source, [
    {
      label: BMCLAPI_LABEL,
      mirror: true,
      load: async () => {
        const data = await fetchJson<Array<{ version: string }>>(
          bmclapiUrl(`/neoforge/list/${encodeURIComponent(mcVersion)}`),
          signal,
        );
        // 1.20.1 的早期版本发布在另一个 Maven 坐标下，官方列表也不含它们，这里同样过滤。
        // BMCLAPI 的返回不保证顺序，部署时留空会取第一项，所以要自己排序。
        return requireEntries(data.map((x) => x.version).filter((v) => matchesNeoForgeMc(v, mcVersion)))
          .sort(newestFirst);
      },
    },
    {
      label: 'NeoForged',
      load: async () => {
        const all = parseMavenVersions(await fetchText(NEOFORGE_METADATA_URL, signal));
        return all.filter((v) => matchesNeoForgeMc(v, mcVersion)).sort(newestFirst);
      },
    },
  ], signal);
}

type VanillaDetail = { downloads?: { server?: { url: string; sha1?: string } } };

/** 读取镜像上的版本详情。它会被转到社区节点，所以要先对上清单里的 SHA-1，jar 的校验值才可信。 */
async function fetchVerifiedDetail(url: string, sha1: string, signal: AbortSignal): Promise<VanillaDetail> {
  const text = await fetchText(url, signal);
  if (createHash('sha1').update(text).digest('hex') !== sha1.toLowerCase()) {
    throw new PanelError('server.system.downloadChecksumMismatch');
  }
  return JSON.parse(text) as VanillaDetail;
}

/**
 * 解析 Vanilla 服务端的下载计划。信任链：清单由 BMCLAPI 主站直接返回（不跳转）或来自 Mojang，
 * 清单里的 SHA-1 核对版本详情，版本详情里的 SHA-1 核对 jar，社区节点改动任何一环都会被发现。
 */
export async function resolveVanillaDownload(
  mcVersion: string,
  signal: AbortSignal,
  source: DownloadSource = getDownloadSource(),
): Promise<DownloadPlan> {
  const manifest = await loadMojangManifest(source, signal);
  const entry = manifest.versions.find((v) => v.id === mcVersion);
  if (!entry) throw new PanelError('server.deploy.vanillaVersionNotFound', { version: mcVersion });
  const mirrorDetailUrl = mojangMirrorUrl(entry.url);
  const detailSha1 = entry.sha1;
  const detail = await loadMetadata<VanillaDetail>(source, [
    ...(mirrorDetailUrl && detailSha1
      ? [{
          label: BMCLAPI_LABEL,
          mirror: true,
          load: () => fetchVerifiedDetail(mirrorDetailUrl, detailSha1, signal),
        }]
      : []),
    { label: 'Mojang', load: () => fetchJson<VanillaDetail>(entry.url, signal) },
  ], signal);
  const server = detail.downloads?.server;
  if (!server?.url) throw new PanelError('server.deploy.vanillaNoServerJar', { version: mcVersion });
  return createDownloadPlan(
    withMirror(source, officialCandidate('Mojang', server.url), mojangMirrorUrl(server.url)),
    server.sha1 ? { algorithm: 'sha1', hex: server.sha1 } : undefined,
  );
}

export async function resolvePaperDownload(
  version: string,
  build?: number,
  signal?: AbortSignal,
): Promise<{ plan: DownloadPlan; build: number; filename: string }> {
  const builds = await fetchJson<PaperBuild[]>(
    `https://fill.papermc.io/v3/projects/paper/versions/${version}/builds`,
    signal,
  );
  if (!builds.length) throw new PanelError('server.deploy.paperNoBuilds', { version });

  let selected: PaperBuild;
  if (build !== undefined) {
    // 指定的构建不存在时直接报错，不能悄悄换成最新构建。
    const requested = builds.find((b) => b.id === build);
    if (!requested) throw new PanelError('server.deploy.paperBuildNotFound', { version, build });
    selected = requested;
  } else {
    const stable = builds.filter((b) => b.channel === 'STABLE');
    const pool = stable.length ? stable : builds;
    selected = pool.sort((a, b) => b.id - a.id)[0]!;
  }

  const file = selected.downloads?.['server:default'];
  if (!file?.url) throw new PanelError('server.deploy.paperNoDownloadUrl', { version, build: selected.id });
  const sha256 = file.checksums?.sha256;
  return {
    // PaperMC 没有可靠的国内镜像，始终走官方；校验值由 Fill 接口一并给出。
    plan: createDownloadPlan(
      [officialCandidate('PaperMC', file.url)],
      sha256 ? { algorithm: 'sha256', hex: sha256 } : undefined,
    ),
    build: selected.id,
    filename: file.name || 'server.jar',
  };
}

/** 基于解析后的不可变版本生成核心缓存文件名（不含目录）。 */
export function buildResolvedCoreCacheBasename(
  coreType: 'vanilla' | 'paper' | 'fabric',
  mcVersion: string,
  resolved: { build?: number; loader?: string; installer?: string },
): string {
  if (coreType === 'vanilla') return `vanilla-${mcVersion}.jar`;
  if (coreType === 'paper') return `paper-${mcVersion}-build-${resolved.build!}.jar`;
  return `fabric-${mcVersion}-loader-${resolved.loader!}-installer-${resolved.installer!}.jar`;
}

export async function resolveFabricJarUrl(
  gameVersion: string,
  loaderVersion?: string,
  installerVersion?: string,
  signal?: AbortSignal,
): Promise<{ url: string; loader: string; installer: string }> {
  const loaders = loaderVersion ? [loaderVersion] : await listFabricLoaders(gameVersion, signal);
  const installers = installerVersion ? [installerVersion] : await listFabricInstallers(signal);
  if (!loaders.length || !installers.length) {
    throw new PanelError('server.deploy.fabricNoVersions', { version: gameVersion });
  }
  const loader = loaders[0]!;
  const installer = installers[0]!;
  const url = `${FABRIC_META_URL}/v2/versions/loader/${gameVersion}/${loader}/${installer}/server/jar`;
  return { url, loader, installer };
}

export function forgeInstallerUrl(mcVersion: string, forgeVersion: string): string {
  const full = `${mcVersion}-${forgeVersion}`;
  return `https://maven.minecraftforge.net/net/minecraftforge/forge/${full}/forge-${full}-installer.jar`;
}

export function neoForgeInstallerUrl(neoVersion: string): string {
  return `https://maven.neoforged.net/releases/net/neoforged/neoforge/${neoVersion}/neoforge-${neoVersion}-installer.jar`;
}

/** 从官方 Maven 读取 .sha256 校验文件；取不到时返回 undefined，由调用方决定怎么处理。 */
async function fetchOfficialSha256(fileUrl: string, signal?: AbortSignal): Promise<ExpectedDigest | undefined> {
  try {
    const hex = (await fetchText(`${fileUrl}.sha256`, signal)).trim().split(/\s+/)[0] ?? '';
    return /^[0-9a-f]{64}$/i.test(hex) ? { algorithm: 'sha256', hex } : undefined;
  } catch (error) {
    if (signal?.aborted) throw error;
    return undefined;
  }
}

/**
 * 解析 Forge / NeoForge 安装器的下载计划。安装器随后会被执行，校验值只从官方 Maven 取：
 * BMCLAPI 的 Maven 路径会跳转到社区节点，同一来源的校验文件证明不了什么。
 * 官方校验文件取不到时计划里只留官方地址。
 */
export async function resolveInstallerDownload(
  coreType: 'forge' | 'neoforge',
  mcVersion: string,
  loaderVersion: string,
  signal?: AbortSignal,
  source: DownloadSource = getDownloadSource(),
): Promise<DownloadPlan> {
  const url = coreType === 'forge' ? forgeInstallerUrl(mcVersion, loaderVersion) : neoForgeInstallerUrl(loaderVersion);
  const label = coreType === 'forge' ? 'MinecraftForge' : 'NeoForged';
  return createDownloadPlan(
    withMirror(source, officialCandidate(label, url), mavenMirrorUrl(url)),
    await fetchOfficialSha256(url, signal),
  );
}
