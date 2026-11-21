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
  isMojangUrl,
  mavenMirrorUrl,
  mojangMirrorUrl,
  officialCandidate,
  rejectInsecureRedirect,
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
    await rejectInsecureRedirect(url, response);
    if (!response.ok) {
      try {
        await response.body?.cancel();
      } catch {
        /* Ignore failures to clean up the error response body */
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

/** A metadata source: sources with mirror true are used only when the China source is selected, and come before official. */
type MetadataSource<T> = { label: string; mirror?: boolean; load: () => Promise<T> };

/** Reads metadata in source order, parsing included, so a mirror returning abnormal content also falls back to official. */
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

/** An empty mirror list counts as a failure, letting official confirm whether this version really has nothing. */
function requireEntries<T>(entries: T[]): T[] {
  if (!entries.length) throw new TypeError('empty metadata');
  return entries;
}

function parseMavenVersions(xml: string): string[] {
  const matches = [...xml.matchAll(/<version>([^<]+)<\/version>/g)];
  return matches.map((m) => m[1]!).filter(Boolean);
}

/**
 * NeoForge version → Minecraft version. Old and new schemes are told apart by segment count, not by the size of the major version:
 * - three segments `<minor>.<patch>.<build>`: 21.1.244 → 1.21.1, 21.0.167 → 1.21
 * - four segments `<year>.<sequence>.<hotfix>.<build>`: 26.1.2.126 → 26.1.2, 26.3.0.101 → 26.3
 * - snapshot builds carry the snapshot name after `+`: 26.1.0.0-alpha.1+snapshot-1 → 26.1-snapshot-1
 * - April Fools versions: 0.25w14craftmine.3-beta → 25w14craftmine
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

/** Version number of a Minecraft release; snapshots, pre-releases and April Fools versions do not match. */
const MC_RELEASE_VERSION = /^\d+\.\d+(?:\.\d+)?$/;

/** Version numbers in descending numeric order, with 21.0.167 before 21.0.98-beta. */
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

/** Fabric Meta's list API; BMCLAPI has the same paths under /fabric-meta. */
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
        // Like the other cores, only releases are listed.
        if (MC_RELEASE_VERSION.test(mcVersion)) mcSet.add(mcVersion);
      } catch {
          /* Ignore entries that cannot be mapped to a Minecraft version */
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

/** Forge loader version list (without the MC prefix), newest first. */
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
        // BMCLAPI's response has no guaranteed order; file names of old versions also carry a branch suffix, which has to be put back to form the download URL.
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

/** NeoForge version list (full NeoForge version numbers), newest first. */
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
        // Early 1.20.1 versions were published under another Maven coordinate and the official list does not include them either, so they are filtered out here too.
        // BMCLAPI's response has no guaranteed order, and deploy takes the first item when left empty, so it has to be sorted here.
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

type VanillaDetail = { downloads?: { server?: { url?: string; sha1?: string } } };

const SHA1_HEX = /^[0-9a-f]{40}$/i;

/** Reads the version details and checks them against the SHA-1 in the manifest: the mirror redirects them to community nodes, and the official URL is checked the same way, which is what makes the jar's checksum trustworthy. */
async function fetchVerifiedDetail(url: string, sha1: string, signal: AbortSignal): Promise<VanillaDetail> {
  const text = await fetchText(url, signal);
  if (createHash('sha1').update(text).digest('hex') !== sha1.toLowerCase()) {
    throw new PanelError('server.system.downloadChecksumMismatch');
  }
  return JSON.parse(text) as VanillaDetail;
}

/**
 * Resolves the download plan for the Vanilla server. Chain of trust: the SHA-1 in the manifest verifies the version details, and the SHA-1 in the details verifies the jar.
 * The manifest is the root of this chain and is fetched only from Mojang under both sources: BMCLAPI 302s the manifest to community nodes,
 * and a node that altered the manifest could alter the checksums of the details and the jar along with it, with nothing to verify a mirrored manifest against.
 * Under the China source the details and jar still try BMCLAPI first, with checksums all coming from Mojang's manifest. The version list only lists version numbers and can still use the mirror.
 * The details and jar URLs must both be Mojang https URLs and both checksums must be present (Mojang has always provided them),
 * otherwise it fails outright instead of falling back to an unverified download.
 */
export async function resolveVanillaDownload(
  mcVersion: string,
  signal: AbortSignal,
  source: DownloadSource = getDownloadSource(),
): Promise<DownloadPlan> {
  let manifest: MojangManifest;
  try {
    manifest = await loadMojangManifest('official', signal);
  } catch (error) {
    if (signal.aborted || source !== 'china') throw error;
    // Under the China source the manifest still goes only to Mojang: explain why, so users do not think the mirror is at fault.
    throw new PanelError('server.deploy.vanillaManifestNeedsMojang', {
      attempts: describeFailures([{ source: 'Mojang', error }]),
    });
  }
  const entry = manifest.versions.find((v) => v.id === mcVersion);
  if (!entry) throw new PanelError('server.deploy.vanillaVersionNotFound', { version: mcVersion });
  const detailSha1 = entry.sha1;
  if (!isMojangUrl(entry.url) || !detailSha1 || !SHA1_HEX.test(detailSha1)) {
    throw new PanelError('server.deploy.vanillaMetadataUntrusted', { version: mcVersion });
  }
  const mirrorDetailUrl = mojangMirrorUrl(entry.url);
  const detail = await loadMetadata<VanillaDetail>(source, [
    ...(mirrorDetailUrl
      ? [{
          label: BMCLAPI_LABEL,
          mirror: true,
          load: () => fetchVerifiedDetail(mirrorDetailUrl, detailSha1, signal),
        }]
      : []),
    { label: 'Mojang', load: () => fetchVerifiedDetail(entry.url, detailSha1, signal) },
  ], signal);
  const server = detail.downloads?.server;
  if (!server?.url) throw new PanelError('server.deploy.vanillaNoServerJar', { version: mcVersion });
  if (!isMojangUrl(server.url) || !server.sha1 || !SHA1_HEX.test(server.sha1)) {
    throw new PanelError('server.deploy.vanillaMetadataUntrusted', { version: mcVersion });
  }
  return createDownloadPlan(
    withMirror(source, officialCandidate('Mojang', server.url), mojangMirrorUrl(server.url)),
    { algorithm: 'sha1', hex: server.sha1 },
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
    // Fail outright when the specified build does not exist; it must not be silently replaced by the latest build.
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
    // PaperMC has no reliable mirror in China, so it always goes to official; the checksum comes with the Fill API response.
    plan: createDownloadPlan(
      [officialCandidate('PaperMC', file.url)],
      sha256 ? { algorithm: 'sha256', hex: sha256 } : undefined,
    ),
    build: selected.id,
    filename: file.name || 'server.jar',
  };
}

/** Builds the core cache file name (without directory) from the resolved immutable version. */
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

/** Reads the .sha256 checksum file from the official Maven; returns undefined when it cannot be fetched, leaving the caller to decide what to do. */
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
 * Resolves the download plan for the Forge / NeoForge installer. The installer is executed afterwards, so the checksum is taken only from the official Maven:
 * BMCLAPI's Maven paths redirect to community nodes, and a checksum file from the same source proves nothing.
 * When the official checksum file cannot be fetched, the plan keeps only the official URL.
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
