import { describe, it, expect } from 'vitest';
import type { NetworkInterfaceInfo } from 'os';
import { isTailscaleAddress, listenHosts, listenModeFromEnv } from './listen.js';

const iface = (address: string, family: 'IPv4' | 'IPv6', internal = false) =>
  ({ address, family, internal, netmask: '', mac: '', cidr: null }) as unknown as NetworkInterfaceInfo;

describe('isTailscaleAddress', () => {
  it('matches the 100.64.0.0/10 range and the Tailscale IPv6 prefix only', () => {
    expect(isTailscaleAddress('100.64.0.1', 'IPv4')).toBe(true);
    expect(isTailscaleAddress('100.101.102.103', 'IPv4')).toBe(true);
    expect(isTailscaleAddress('100.127.255.254', 'IPv4')).toBe(true);
    expect(isTailscaleAddress('100.128.0.1', 'IPv4')).toBe(false);
    expect(isTailscaleAddress('100.63.0.1', 'IPv4')).toBe(false);
    expect(isTailscaleAddress('192.168.1.20', 'IPv4')).toBe(false);
    expect(isTailscaleAddress('fd7a:115c:a1e0::1234', 'IPv6')).toBe(true);
    expect(isTailscaleAddress('fe80::1', 'IPv6')).toBe(false);
  });
});

describe('listenHosts', () => {
  const ifaces = {
    lo0: [iface('127.0.0.1', 'IPv4', true), iface('::1', 'IPv6', true)],
    en0: [iface('192.168.1.20', 'IPv4'), iface('fe80::1c2b', 'IPv6')],
    utun4: [iface('100.88.1.2', 'IPv4'), iface('fd7a:115c:a1e0::77', 'IPv6')],
  };

  it('binds every interface in "all" mode', () => {
    expect(listenHosts('all', ifaces)).toBeNull();
  });

  it('binds loopback plus Tailscale addresses, never the LAN, in "local+tailscale" mode', () => {
    expect(listenHosts('local+tailscale', ifaces)).toEqual(['127.0.0.1', '::1', '100.88.1.2', 'fd7a:115c:a1e0::77']);
  });

  it('binds loopback only while Tailscale is down', () => {
    expect(listenHosts('local+tailscale', { lo0: ifaces.lo0, en0: ifaces.en0 })).toEqual(['127.0.0.1', '::1']);
  });

  it('defaults to "all" unless the env asks for local+tailscale', () => {
    expect(listenModeFromEnv(undefined)).toBe('all');
    expect(listenModeFromEnv('anything')).toBe('all');
    expect(listenModeFromEnv('local+tailscale')).toBe('local+tailscale');
  });
});
