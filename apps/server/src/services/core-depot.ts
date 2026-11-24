import fs from 'node:fs';
import path from 'node:path';
import type { DeployCoreInput } from '@mystry/shared';
import { nanoid } from 'nanoid';
import { config } from '../config.js';
import { registerPromotedInstance } from './instance-service.js';
import { detectJarFile, findModLoaderArgsFile } from './server-launch-detect.js';
import { resolveSafePath } from '../utils/path.js';
import { recordTaskStaging, runBackgroundTask } from './task-service.js';
import { prepareTaskStaging, promoteTaskStagingToInstance, removeTaskStagingTree } from './task-staging-service.js';
import { normalizeAndAssertJvmArgs } from './jvm-validation-service.js';
import { resolveJavaRuntimeCommand } from './java-runtime-service.js';
import { PanelError, throwIfAborted } from '../utils/errors.js';
import { ensureCoreCache, verifyCoreCache } from './core-download.js';
import { runInstaller, writeUserJvmArgs } from './core-installer.js';
import { createDownloadPlan, getDownloadSource, officialCandidate, type DownloadPlan } from './download-sources.js';
import { prefetchInstallerFiles } from './installer-prefetch.js';
import {
  buildResolvedCoreCacheBasename,
  listForgeLoaders,
  listNeoForgeLoaders,
  resolveFabricJarUrl,
  resolveInstallerDownload,
  resolvePaperDownload,
  resolveVanillaDownload,
} from './core-metadata.js';

export async function deployCore(input: DeployCoreInput) {
  input = {
    ...input,
    jvmArgs: normalizeAndAssertJvmArgs(input.jvmArgs ?? '-Xms1G -Xmx2G', {
      coreType: input.coreType,
      javaRuntimeId: input.javaRuntimeId,
    }),
  };
  return runBackgroundTask(
    'deploy',
    { key: 'server.deploy.progress.deploying', params: { coreType: input.coreType, mcVersion: input.mcVersion } },
    async (taskId, signal, report) => {
      let instanceId: string | null = null;
      let stagingToken: string | null = null;
      let completed = false;
      try {
        throwIfAborted(signal);
        instanceId = nanoid(12);
        stagingToken = nanoid(32);
        recordTaskStaging(taskId, instanceId, stagingToken);
        const dir = prepareTaskStaging(taskId, instanceId, stagingToken);
        const writeEulaIfNeeded = () => {
          if (input.acceptEula) {
            fs.writeFileSync(resolveSafePath(dir, 'eula.txt'), 'eula=true\n', 'utf8');
          }
        };

        let jarFile: string;
        const usesInstaller = input.coreType === 'forge' || input.coreType === 'neoforge';
        if (input.coreType === 'forge' || input.coreType === 'neoforge') {
          throwIfAborted(signal);
          report(5, { key: 'server.deploy.progress.resolvingLoader' });
          let loaderVersion = input.loaderVersion;
          if (!loaderVersion) {
            const loaders =
              input.coreType === 'forge'
                ? await listForgeLoaders(input.mcVersion, signal)
                : await listNeoForgeLoaders(input.mcVersion, signal);
            loaderVersion = loaders[0];
          }
          if (!loaderVersion) {
            throw new PanelError('server.deploy.loaderNoVersions', { coreType: input.coreType, mcVersion: input.mcVersion });
          }

          const installerName =
            input.coreType === 'forge'
              ? `forge-${input.mcVersion}-${loaderVersion}-installer.jar`
              : `neoforge-${loaderVersion}-installer.jar`;
          const cachePath = path.join(
            config.cacheDir,
            installerName.replace(/[^\w.-]+/g, '_'),
          );
          const installerDest = resolveSafePath(dir, installerName);

          // Resolve the download plan before looking at the cache: the cache is shared across sources and must be checked against the official Maven checksum before being executed.
          // Offline, .sha256 cannot be fetched and the plan carries no checksum; a non-empty cache can still be used directly.
          throwIfAborted(signal);
          const plan = await resolveInstallerDownload(input.coreType, input.mcVersion, loaderVersion, signal);
          if (await verifyCoreCache(cachePath, plan.expected, signal)) {
            throwIfAborted(signal);
            report(20, { key: 'server.deploy.progress.usingCachedInstaller' });
            fs.copyFileSync(cachePath, installerDest);
          } else {
            throwIfAborted(signal);
            report(15, { key: 'server.deploy.progress.downloadingInstaller' });
            await ensureCoreCache(plan, cachePath, installerName, (ratio, source) => {
              report(15 + ratio * 40, {
                key: 'server.deploy.progress.downloadingInstallerFrom',
                params: { source, percent: Math.round(ratio * 100) },
              });
            }, signal);
            throwIfAborted(signal);
            fs.copyFileSync(cachePath, installerDest);
          }

          if (getDownloadSource() === 'china') {
            await prefetchInstallerFiles(installerDest, dir, signal, (done, total) => {
              report(56 + (done / total) * 3, {
                key: 'server.deploy.progress.prefetchingLibraries',
                params: { done, total },
              });
            });
          }

          throwIfAborted(signal);
          report(60, { key: 'server.deploy.progress.runningInstaller' });
          writeUserJvmArgs(dir, input.jvmArgs || '-Xms1G -Xmx2G');
          const javaCommand = await resolveJavaRuntimeCommand(input.javaRuntimeId);
          await runInstaller(installerDest, dir, javaCommand, signal, (progress, message) => {
            report(progress, message);
          });

          try {
            fs.unlinkSync(installerDest);
          } catch {
            /* A cleanup failure does not affect the launch target detection that follows */
          }

          throwIfAborted(signal);
          report(85, { key: 'server.deploy.progress.detectingLaunch' });
          const argsFile = await findModLoaderArgsFile(dir, input.coreType, {
            maxDepth: config.modLoaderScanMaxDepth,
            maxEntries: config.modLoaderScanMaxEntries,
            deadlineMs: config.modLoaderScanTimeoutMs,
            signal,
          });
          jarFile = '@modloader';
          if (argsFile) {
            jarFile = `@args:${argsFile}`;
          } else {
            const jar = detectJarFile(dir);
            if (!jar) {
              throw new PanelError('server.deploy.launchTargetNotFound');
            }
            jarFile = jar;
          }

          writeEulaIfNeeded();
          throwIfAborted(signal);
          report(95, { key: 'server.deploy.progress.writingInstance' });
        } else {
          // Vanilla / Paper / Fabric: download the jar directly
          throwIfAborted(signal);
          const destJar = resolveSafePath(dir, 'server.jar');

          report(5, { key: 'server.deploy.progress.resolvingUrl' });

          let plan: DownloadPlan;
          let cacheBasename: string;
          if (input.coreType === 'vanilla') {
            plan = await resolveVanillaDownload(input.mcVersion, signal);
            cacheBasename = buildResolvedCoreCacheBasename('vanilla', input.mcVersion, {});
          } else if (input.coreType === 'paper') {
            const paper = await resolvePaperDownload(input.mcVersion, input.build, signal);
            plan = paper.plan;
            cacheBasename = buildResolvedCoreCacheBasename('paper', input.mcVersion, { build: paper.build });
          } else {
            const fabric = await resolveFabricJarUrl(
              input.mcVersion,
              input.loaderVersion,
              input.installerVersion,
              signal,
            );
            // Fabric's server jar is generated on the fly by the official API and BMCLAPI does not provide it, so it always goes to official.
            plan = createDownloadPlan([officialCandidate('FabricMC', fabric.url)]);
            cacheBasename = buildResolvedCoreCacheBasename('fabric', input.mcVersion, {
              loader: fabric.loader,
              installer: fabric.installer,
            });
          }
          const cachePath = path.join(config.cacheDir, cacheBasename.replace(/[^\w.-]+/g, '_'));

          // The cache is reused only after being checked against the plan's checksum; a mismatch is deleted and downloaded again.
          if (await verifyCoreCache(cachePath, plan.expected, signal)) {
            throwIfAborted(signal);
            report(60, { key: 'server.deploy.progress.usingCache' });
            fs.copyFileSync(cachePath, destJar);
          } else {
            throwIfAborted(signal);
            report(15, { key: 'server.deploy.progress.startingDownload' });
            await ensureCoreCache(plan, cachePath, cacheBasename, (ratio, source) => {
              report(15 + ratio * 70, {
                key: 'server.deploy.progress.downloadingFrom',
                params: { source, percent: Math.round(ratio * 100) },
              });
            }, signal);
            throwIfAborted(signal);
            fs.copyFileSync(cachePath, destJar);
          }

          throwIfAborted(signal);
          report(95, { key: 'server.deploy.progress.writingConfig' });
          writeEulaIfNeeded();
          report(97, { key: 'server.deploy.progress.writingInstance' });
          jarFile = 'server.jar';
        }

        // Once the directory has landed, registration must follow; no await or cancellation check may be added here.
        promoteTaskStagingToInstance(taskId, instanceId);
        registerPromotedInstance(instanceId, {
          name: input.name,
          coreType: input.coreType,
          mcVersion: input.mcVersion,
          jarFile,
          jvmArgs: input.jvmArgs,
          acceptEula: input.acceptEula,
          javaRuntimeId: input.javaRuntimeId ?? null,
        });
        completed = true;
        if (usesInstaller) report(100, { key: 'server.deploy.progress.completed' });
        return { instanceId };
      } finally {
        if (!completed && instanceId) {
          try {
            await removeTaskStagingTree(taskId, instanceId);
          } catch {
            /* A cleanup failure does not override the original error */
          }
        }
      }
    },
  );
}
