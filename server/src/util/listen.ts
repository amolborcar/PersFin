import type { NetworkInterfaceInfo } from 'os';

// Which addresses the server listens on.
//
//  'all'              — every interface (the default; dev and older setups).
//  'local+tailscale'  — loopback plus this machine's Tailscale addresses only,
//                       so the always-on server is reachable from this Mac and
//                       from the owner's tailnet, but not from the local LAN.
//                       Set by the launchd agent (PERSFIN_LISTEN).
//
// Tailscale assigns IPv4 addresses from 100.64.0.0/10 (the CGNAT range) and IPv6
// addresses from fd7a:115c:a1e0::/48. Pure, so it can be tested without a network.

export type ListenMode = 'all' | 'local+tailscale';

export function listenModeFromEnv(v: string | undefined): ListenMode {
  return v === 'local+tailscale' ? 'local+tailscale' : 'all';
}

export function isTailscaleAddress(address: string, family: string | number): boolean {
  if (family === 'IPv4' || family === 4) {
    const [a, b] = address.split('.').map(Number);
    return a === 100 && b >= 64 && b <= 127;
  }
  return address.toLowerCase().startsWith('fd7a:115c:a1e0:');
}

export const LOOPBACK_HOSTS = ['127.0.0.1', '::1'];

// The hosts to bind for `mode`, or null for "all interfaces" (one plain listen).
export function listenHosts(
  mode: ListenMode,
  ifaces: NodeJS.Dict<NetworkInterfaceInfo[]>,
): string[] | null {
  if (mode === 'all') return null;
  const tailscale = Object.values(ifaces)
    .flatMap(list => list ?? [])
    .filter(i => !i.internal && isTailscaleAddress(i.address, i.family))
    .map(i => i.address);
  return [...LOOPBACK_HOSTS, ...new Set(tailscale)];
}
