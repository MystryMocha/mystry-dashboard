import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import type { AddressInfo } from 'node:net';

process.env.JWT_SECRET = 'a'.repeat(64);
process.env.SETUP_TOKEN = 'b'.repeat(64);
process.env.LAUNCHER_TOKEN = 'c'.repeat(64);

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mystry-certificate-test-'));
process.env.MYSTRY_HOME = dataRoot;
process.env.MYSTRY_DATA_DIR = dataRoot;
test.after(() => fs.rmSync(dataRoot, { recursive: true, force: true }));

const DAY_MS = 24 * 60 * 60 * 1000;

/** Starts a real HTTPS server with this certificate, then handshakes with a client that trusts only it, under the default rules (including hostname verification). */
async function handshake(certPem: string, keyPem: string, servername: string | undefined, host = '127.0.0.1'): Promise<string> {
  const server = https.createServer({ cert: certPem, key: keyPem }, (_req, res) => res.end('ok'));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    return await new Promise<string>((resolve, reject) => {
      const socket = tls.connect({ host: '127.0.0.1', port, ca: certPem, servername, checkServerIdentity: (_name, cert) => tls.checkServerIdentity(host, cert) }, () => {
        const protocol = socket.getProtocol() ?? '';
        socket.end();
        resolve(protocol);
      });
      socket.once('error', reject);
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('生成的证书能被解析，内容符合设计', async () => {
  const { generatePanelCertificate, describeCertificate, CERTIFICATE_VALID_DAYS } = await import('./panel-certificate.js');
  const now = new Date('2026-11-17T08:00:00Z');
  const { certPem, keyPem } = generatePanelCertificate(
    ['192.168.2.163', '203.0.113.10', 'mc.example.com', '2408:8207:ab::10', '192.168.2.163', 'not a host', 'fe80::1%eth0'],
    now,
  );
  const x509 = new crypto.X509Certificate(certPem);
  assert.equal(x509.subject, 'CN=Mystry Dashboard');
  assert.equal(x509.issuer, 'CN=Mystry Dashboard');
  assert.equal(x509.ca, false);
  assert.deepEqual(x509.keyUsage, ['1.3.6.1.5.5.7.3.1']);
  assert.equal(x509.publicKey.asymmetricKeyType, 'ec');
  assert.equal(x509.publicKey.asymmetricKeyDetails?.namedCurve, 'prime256v1');
  // Self-signed: the signature verifies with the certificate's own public key, and the private key matches the certificate.
  assert.equal(x509.verify(x509.publicKey), true);
  assert.equal(x509.checkPrivateKey(crypto.createPrivateKey(keyPem)), true);
  assert.equal(new Date(x509.validTo).getTime() - now.getTime(), CERTIFICATE_VALID_DAYS * DAY_MS);
  assert.ok(new Date(x509.validFrom).getTime() < now.getTime());
  assert.equal(x509.checkIP('192.168.2.163'), '192.168.2.163');
  assert.equal(x509.checkIP('203.0.113.10'), '203.0.113.10');
  assert.ok(x509.checkIP('2408:8207:ab::10'));
  assert.equal(x509.checkHost('mc.example.com'), 'mc.example.com');
  assert.equal(x509.checkIP('10.0.0.1'), undefined);

  const info = describeCertificate(certPem);
  assert.equal(info.fingerprint256, x509.fingerprint256);
  assert.match(info.fingerprint256, /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
  assert.equal(info.notAfter, new Date(now.getTime() + CERTIFICATE_VALID_DAYS * DAY_MS).toISOString());
  assert.equal(info.addresses.length, 4);
  assert.ok(info.addresses.includes('192.168.2.163'));
  assert.ok(info.addresses.includes('mc.example.com'));
});

test('没有可用地址时 SAN 写入 localhost', async () => {
  const { generatePanelCertificate, describeCertificate } = await import('./panel-certificate.js');
  assert.deepEqual(describeCertificate(generatePanelCertificate([]).certPem).addresses, ['localhost']);
});

test('真实 TLS 握手：信任这张证书的客户端按 IP 和域名都能校验通过', async () => {
  const { generatePanelCertificate } = await import('./panel-certificate.js');
  const { certPem, keyPem } = generatePanelCertificate(['127.0.0.1', '192.168.2.163', 'panel.example.com']);
  assert.match(await handshake(certPem, keyPem, undefined, '127.0.0.1'), /^TLSv1\.[23]$/);
  assert.match(await handshake(certPem, keyPem, undefined, '192.168.2.163'), /^TLSv1\.[23]$/);
  assert.match(await handshake(certPem, keyPem, 'panel.example.com', 'panel.example.com'), /^TLSv1\.[23]$/);
  // Addresses not in the SAN must be rejected.
  await assert.rejects(handshake(certPem, keyPem, undefined, '10.0.0.1'), /altnames|IP: 10\.0\.0\.1/i);
});

test('不信任这张证书的客户端拒绝连接', async () => {
  const { generatePanelCertificate } = await import('./panel-certificate.js');
  const { certPem, keyPem } = generatePanelCertificate(['127.0.0.1']);
  const server = https.createServer({ cert: certPem, key: keyPem }, (_req, res) => res.end('ok'));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    await assert.rejects(
      new Promise((resolve, reject) => {
        const socket = tls.connect({ host: '127.0.0.1', port }, () => resolve(null));
        socket.once('error', reject);
      }),
      (error: NodeJS.ErrnoException) => error.code === 'DEPTH_ZERO_SELF_SIGNED_CERT',
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('已有证书复用；快过期、损坏、私钥不配对或要求重新生成时换新', async () => {
  const { loadOrCreatePanelCertificate, panelCertificatePaths, readPanelCertificateInfo, generatePanelCertificate } =
    await import('./panel-certificate.js');
  const dataDir = fs.mkdtempSync(path.join(dataRoot, 'store-'));
  const paths = panelCertificatePaths(dataDir);
  const now = new Date('2026-11-17T08:00:00Z');
  assert.equal(readPanelCertificateInfo(dataDir), null);

  const first = loadOrCreatePanelCertificate(['192.168.1.2'], { now, dataDir });
  assert.ok(fs.existsSync(paths.key) && fs.existsSync(paths.cert));
  if (process.platform !== 'win32') assert.equal(fs.statSync(paths.key).mode & 0o777, 0o600);
  assert.equal(readPanelCertificateInfo(dataDir)?.fingerprint256, first.info.fingerprint256);

  // Not regenerated when addresses change: the fingerprint stays the same, so the browser does not need to confirm again.
  const reused = loadOrCreatePanelCertificate(['10.0.0.9'], { now, dataDir });
  assert.equal(reused.info.fingerprint256, first.info.fingerprint256);
  assert.deepEqual(reused.info.addresses, ['192.168.1.2']);

  // Reused with 31 days left, regenerated with 29 days left.
  const day = (days: number) => new Date(now.getTime() + days * DAY_MS);
  assert.equal(loadOrCreatePanelCertificate([], { now: day(800 - 31), dataDir }).info.fingerprint256, first.info.fingerprint256);
  const renewed = loadOrCreatePanelCertificate(['10.0.0.9'], { now: day(800 - 29), dataDir });
  assert.notEqual(renewed.info.fingerprint256, first.info.fingerprint256);
  assert.deepEqual(renewed.info.addresses, ['10.0.0.9']);

  const later = day(800 - 29);
  fs.writeFileSync(paths.cert, 'not a certificate');
  const repaired = loadOrCreatePanelCertificate(['10.0.0.9'], { now: later, dataDir });
  assert.notEqual(repaired.info.fingerprint256, renewed.info.fingerprint256);

  fs.writeFileSync(paths.key, generatePanelCertificate(['10.0.0.9']).keyPem);
  const rekeyed = loadOrCreatePanelCertificate(['10.0.0.9'], { now: later, dataDir });
  assert.notEqual(rekeyed.info.fingerprint256, repaired.info.fingerprint256);

  const forced = loadOrCreatePanelCertificate(['10.0.0.9'], { now: later, dataDir, forceRenew: true });
  assert.notEqual(forced.info.fingerprint256, rekeyed.info.fingerprint256);
  assert.equal(loadOrCreatePanelCertificate([], { now: later, dataDir }).info.fingerprint256, forced.info.fingerprint256);
});
