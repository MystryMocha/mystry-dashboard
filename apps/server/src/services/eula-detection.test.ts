import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { eulaFileFingerprint, hasAcceptedEula, isEulaAcceptedText } from './eula-detection.js';

test('eula.txt counts as accepted only where the server itself would read acceptance', () => {
  const accepted = [
    '#By changing the setting below to TRUE you are indicating your agreement to our EULA (https://aka.ms/MinecraftEULA).\n#Sun Nov 22 18:59:15 GMT+08:00 2026\neula=true\n',
    'eula=TRUE',
    'eula = true\r\n',
    '  eula:true',
    'eula true',
    'eula=false\neula=true\n',
  ];
  const rejected = [
    '',
    'eula=false\n',
    '#eula=true\n',
    '!eula=true\n',
    'eula=true \n',
    'eula=yes\n',
    'EULA=true\n',
    'eulas=true\n',
    '﻿eula=true\n',
    'eula=true\neula=false\n',
    // A trailing backslash joins the next line into this value, so Java does not see eula=true here.
    'note=see \\\neula=true\n',
  ];
  for (const text of accepted) assert.equal(isEulaAcceptedText(text), true, JSON.stringify(text));
  for (const text of rejected) assert.equal(isEulaAcceptedText(text), false, JSON.stringify(text));
});

test('only a regular eula.txt in the server root is read, and its fingerprint follows edits', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mystry-eula-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'eula.txt');

  assert.equal(hasAcceptedEula(root), false);
  assert.equal(eulaFileFingerprint(root), 'missing');

  fs.writeFileSync(file, 'eula=false\n');
  const before = eulaFileFingerprint(root);
  assert.equal(hasAcceptedEula(root), false);

  fs.writeFileSync(file, 'eula=true\n\n');
  assert.equal(hasAcceptedEula(root), true);
  assert.notEqual(eulaFileFingerprint(root), before);

  fs.rmSync(file);
  fs.mkdirSync(file);
  assert.equal(hasAcceptedEula(root), false);
});
