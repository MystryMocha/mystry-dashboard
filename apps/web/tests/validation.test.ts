import { describe, expect, it } from 'vitest';
import {
  frpHostIssue,
  frpTokenIssue,
  instanceNameIssue,
  integerIssue,
  lanPeersIssue,
  newPasswordIssue,
  portIssue,
  publicHostIssue,
} from '../src/validation';

// Local form validation must match the server rules: a value blocked here is rejected by the server too, and a common form allowed here is accepted by the server too.
describe('表单本地校验', () => {
  it('实例名称：去掉空格后不能为空，最多 128 个字符', () => {
    expect(instanceNameIssue('')?.key).toBe('validation.instanceName.required');
    expect(instanceNameIssue('   ')?.key).toBe('validation.instanceName.required');
    expect(instanceNameIssue('a'.repeat(128))).toBeNull();
    expect(instanceNameIssue('a'.repeat(129))?.key).toBe('validation.instanceName.tooLong');
    expect(instanceNameIssue('我的服务器')).toBeNull();
  });

  it('端口与整数范围', () => {
    for (const bad of ['', '0', '-5', '70000', '1.5', 'abc']) expect(portIssue(bad)).not.toBeNull();
    for (const good of ['1', '25565', '65535', ' 7000 ']) expect(portIssue(good)).toBeNull();
    expect(portIssue('', true)).toBeNull();
    expect(integerIssue('-1', -1)).toBeNull();
    expect(integerIssue('-2', -1)?.key).toBe('validation.number.min');
    expect(integerIssue('33', 3, 32)?.key).toBe('validation.number.range');
  });

  it('新密码：12–128 个字符且不超过 72 字节', () => {
    expect(newPasswordIssue('')).toBeNull();
    expect(newPasswordIssue('short')?.key).toBe('server.auth.passwordTooShort');
    expect(newPasswordIssue('a'.repeat(72))).toBeNull();
    expect(newPasswordIssue('a'.repeat(73))?.key).toBe('server.auth.passwordTooManyBytes');
    expect(newPasswordIssue('密'.repeat(24))).toBeNull();
    expect(newPasswordIssue('密'.repeat(30))?.key).toBe('server.auth.passwordTooManyBytes');
  });

  it('frp 服务器地址和令牌', () => {
    expect(frpHostIssue('')).toBeNull();
    expect(frpHostIssue('frp.example.com')).toBeNull();
    expect(frpHostIssue('203.0.113.10')).toBeNull();
    for (const bad of ['frp.example.com:7000', 'https://frp.example.com', 'a b', 'a\\b', '[::1]']) {
      expect(frpHostIssue(bad)?.key).toBe('server.frp.hostInvalid');
    }
    expect(frpTokenIssue('secret')).toBeNull();
    expect(frpTokenIssue('a\u0001b')?.key).toBe('server.frp.tokenInvalid');
    expect(frpTokenIssue('{{x}}')?.key).toBe('server.frp.tokenInvalid');
  });

  it('中继节点', () => {
    expect(lanPeersIssue(['tcp://relay.example.com:11010', 'wss://relay.example.com:443/', 'udp://[2001:db8::1]:11010'])).toBeNull();
    expect(lanPeersIssue(['relay.example.com:11010'])?.params).toEqual({ peer: 'relay.example.com:11010' });
    expect(lanPeersIssue(['tcp://x:99999'])).not.toBeNull();
    expect(lanPeersIssue(['http://relay.example.com:80'])).not.toBeNull();
    expect(lanPeersIssue(['tcp://relay.example.com:11010/'])).not.toBeNull();
  });

  it('公网地址', () => {
    expect(publicHostIssue('')).toBeNull();
    for (const good of ['203.0.113.10', 'mc.example.com', 'https://mc.example.com/', '2001:db8::1', '[2001:db8::1]']) {
      expect(publicHostIssue(good)).toBeNull();
    }
    expect(publicHostIssue('1.2.3')?.key).toBe('server.publicHost.invalid');
    expect(publicHostIssue('a b')?.key).toBe('server.publicHost.invalid');
    expect(publicHostIssue('mc.example.com:25565')?.key).toBe('server.publicHost.hasPort');
    expect(publicHostIssue('203.0.113.10:25565')?.key).toBe('server.publicHost.hasPort');
    expect(publicHostIssue('[2001:db8::1]:25565')?.key).toBe('server.publicHost.hasPort');
  });
});
