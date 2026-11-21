import assert from 'node:assert/strict';
import test from 'node:test';
import { diagnoseStartFailure } from './start-diagnosis.js';

test('recognized as eula when the EULA is not accepted', () => {
  const output = [
    '[13:23:04] [Server thread/WARN]: Failed to load eula.txt',
    '[13:23:04] [Server thread/INFO]: You need to agree to the EULA in order to run the server. Go to eula.txt for more info.',
  ].join('\n');
  assert.deepEqual(diagnoseStartFailure(output, '1.12.2'), { kind: 'eula', requiredJava: null });
});

test('an EULA sentence appearing in player chat does not count', () => {
  const output = [
    '[10:00:00] [Server thread/INFO]: Done (3.1s)! For help, type "help"',
    '[10:05:00] [Server thread/INFO]: <Steve> You need to agree to the EULA in order to run the server',
  ].join('\n');
  assert.equal(diagnoseStartFailure(output, '1.20.1'), null);
});

test('the LaunchWrapper error of old Forge on a newer Java is recognized as Java too new, needing Java 8', () => {
  const output = 'Caused by: java.lang.ClassCastException: class jdk.internal.loader.ClassLoaders$AppClassLoader '
    + 'cannot be cast to class java.net.URLClassLoader (jdk.internal.loader.ClassLoaders$AppClassLoader and '
    + 'java.net.URLClassLoader are in module java.base of loader \'bootstrap\')';
  assert.deepEqual(diagnoseStartFailure(output, null), { kind: 'java-too-new', requiredJava: 8 });
});

test('a class file version that is too high is recognized as Java too old, and the needed version is derived', () => {
  const output = 'Error: LinkageError occurred while loading main class net.minecraft.bundler.Main\n'
    + '\tjava.lang.UnsupportedClassVersionError: net/minecraft/bundler/Main has been compiled by a more recent '
    + 'version of the Java Runtime (class file version 65.0), this version of the Java Runtime only recognizes '
    + 'class file versions up to 61.0';
  assert.deepEqual(diagnoseStartFailure(output, '1.21.1'), { kind: 'java-too-old', requiredJava: 21 });
});

test('without a class version number the Java recommended for the Minecraft version is used', () => {
  const output = 'Exception in thread "main" java.lang.UnsupportedClassVersionError: Unsupported major.minor';
  assert.deepEqual(diagnoseStartFailure(output, '1.18.2'), { kind: 'java-too-old', requiredJava: 17 });
  assert.deepEqual(diagnoseStartFailure(output, null), { kind: 'java-too-old', requiredJava: null });
});

test('the version notice from the core itself', () => {
  assert.deepEqual(
    diagnoseStartFailure('Minecraft 1.19 requires running the server with Java 17 or above. Download Java 17', '1.19'),
    { kind: 'java-too-old', requiredJava: 17 },
  );
  assert.deepEqual(
    diagnoseStartFailure('Unsupported Java detected (61.0). Only up to Java 16 is supported.', '1.16.5'),
    { kind: 'java-too-new', requiredJava: 16 },
  );
});

test('an exit after the server started successfully is not attributed to Java, and an ordinary crash returns null', () => {
  const started = '[10:00:00] [Server thread/INFO]: Done (3.1s)! For help, type "help"\n'
    + 'java.lang.UnsupportedClassVersionError: some/plugin/Main (class file version 65.0)';
  assert.equal(diagnoseStartFailure(started, '1.20.1'), null);
  assert.equal(diagnoseStartFailure('java.lang.OutOfMemoryError: Java heap space', '1.20.1'), null);
  assert.equal(diagnoseStartFailure('', null), null);
});
