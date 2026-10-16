import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { BlockList, isIP, type LookupFunction } from 'node:net';

/**
 * SSRF protection for outbound webhooks: refuses loopback, private, link-local (incl. the cloud
 * metadata address 169.254.169.254), CGNAT, multicast and reserved ranges.
 */
const blocked = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  blocked.addSubnet(net, prefix, 'ipv4');
}
for (const [net, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
  ['64:ff9b::', 96],
] as const) {
  blocked.addSubnet(net, prefix, 'ipv6');
}

export function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return blocked.check(address, 'ipv4');
  if (family === 6) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
    if (mapped?.[1]) return blocked.check(mapped[1], 'ipv4');
    return blocked.check(address, 'ipv6');
  }
  return true; // not an IP at all: refuse
}

export class BlockedDestinationError extends Error {
  constructor(host: string) {
    super(`Destination ${host} resolves to a private or reserved address`);
    this.name = 'BlockedDestinationError';
  }
}

/**
 * A `dns.lookup` replacement for the HTTP agent. Validation happens on the addresses actually used
 * to connect, so a DNS answer that changes between check and connect (DNS rebinding) cannot slip
 * through.
 */
export const guardedLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses: LookupAddress[]) => {
    if (err) {
      callback(err, '');
      return;
    }
    const list = addresses;
    const bad = list.find((a) => isBlockedAddress(a.address));
    if (bad || list.length === 0) {
      callback(Object.assign(new BlockedDestinationError(hostname), { code: 'EBLOCKED' }), '');
      return;
    }
    if (options.all) {
      callback(null, list);
    } else {
      const first = list[0] as LookupAddress;
      callback(null, first.address, first.family);
    }
  });
};
