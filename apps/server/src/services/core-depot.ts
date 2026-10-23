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
import { ensureCoreCache, isUsableCoreCache } from './core-download.js';
import { runInstaller, writeUserJvmArgs } from './core-installer.js';
import {
  buildResolvedCoreCacheBasename,
  forgeInstallerUrl,
  listForgeLoaders,
  listNeoForgeLoaders,
  neoForgeInstallerUrl,
  resolveFabricJarUrl,
  resolvePaperDownload,
  resolveVanillaServerUrl,
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

          const installerUrl =
            input.coreType === 'forge'
              ? forgeInstallerUrl(input.mcVersion, loaderVersion)
              : neoForgeInstallerUrl(loaderVersion);
          const installerName =
            input.coreType === 'forge'
              ? `forge-${input.mcVersion}-${loaderVersion}-installer.jar`
              : `neoforge-${loaderVersion}-installer.jar`;
          const cachePath = path.join(
            config.cacheDir,
            installerName.replace(/[^\w.-]+/g, '_'),
          );
          const installerDest = resolveSafePath(dir, installerName);

          if (isUsableCoreCache(cachePath)) {
            throwIfAborted(signal);
            report(20, { key: 'server.deploy.progress.usingCachedInstaller' });
            fs.copyFileSync(cachePath, installerDest);
          } else {
            throwIfAborted(signal);
            report(15, { key: 'server.deploy.progress.downloadingInstaller' });
            await ensureCoreCache(installerUrl, cachePath, (ratio) => {
              report(15 + ratio * 40, { key: 'server.deploy.progress.downloadingInstallerPercent', params: { percent: Math.round(ratio * 100) } });
            }, signal);
            throwIfAborted(signal);
            fs.copyFileSync(cachePath, installerDest);
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
            /* 清理失败不影响后续启动目标探测 */
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
          // Vanilla / Paper / Fabric：直接下载 jar
          throwIfAborted(signal);
          const destJar = resolveSafePath(dir, 'server.jar');

          report(5, { key: 'server.deploy.progress.resolvingUrl' });

          let downloadUrl: string;
          let cacheBasename: string;
          if (input.coreType === 'vanilla') {
            downloadUrl = await resolveVanillaServerUrl(input.mcVersion, signal);
            cacheBasename = buildResolvedCoreCacheBasename('vanilla', input.mcVersion, {});
          } else if (input.coreType === 'paper') {
            const paper = await resolvePaperDownload(input.mcVersion, input.build, signal);
            downloadUrl = paper.url;
            cacheBasename = buildResolvedCoreCacheBasename('paper', input.mcVersion, { build: paper.build });
          } else {
            const fabric = await resolveFabricJarUrl(
              input.mcVersion,
              input.loaderVersion,
              input.installerVersion,
              signal,
            );
            downloadUrl = fabric.url;
            cacheBasename = buildResolvedCoreCacheBasename('fabric', input.mcVersion, {
              loader: fabric.loader,
              installer: fabric.installer,
            });
          }
          const cachePath = path.join(config.cacheDir, cacheBasename.replace(/[^\w.-]+/g, '_'));

          if (isUsableCoreCache(cachePath)) {
            throwIfAborted(signal);
            report(60, { key: 'server.deploy.progress.usingCache' });
            fs.copyFileSync(cachePath, destJar);
          } else {
            throwIfAborted(signal);
            report(15, { key: 'server.deploy.progress.startingDownload' });
            await ensureCoreCache(downloadUrl, cachePath, (ratio) => {
              report(15 + ratio * 70, { key: 'server.deploy.progress.downloading', params: { percent: Math.round(ratio * 100) } });
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

        // 目录一旦落地就必须继续注册；此处不能加入 await 或取消检查。
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
            removeTaskStagingTree(taskId, instanceId);
          } catch {
            /* 清理失败不覆盖原始错误 */
          }
        }
      }
    },
  );
}
