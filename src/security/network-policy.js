import { lookup as dnsLookup } from 'node:dns/promises';
import net from 'node:net';

const DNS_CACHE_TTL_MS = 60_000;

export class UnsafeCrawlTargetError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UnsafeCrawlTargetError';
  }
}

function ipv4ToInteger(address) {
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some(octet => !Number.isInteger(octet) || octet < 0 || octet > 255)) return null;
  return ((octets[0] * 0x1000000) + (octets[1] << 16) + (octets[2] << 8) + octets[3]) >>> 0;
}

function inIpv4Range(address, base, maskBits) {
  const value = ipv4ToInteger(address);
  const rangeBase = ipv4ToInteger(base);
  if (value === null || rangeBase === null) return false;
  const mask = maskBits === 0 ? 0 : (0xffffffff << (32 - maskBits)) >>> 0;
  return (value & mask) === (rangeBase & mask);
}

function ipv6ToBigInt(address) {
  let value = address.toLowerCase().replace(/^\[|\]$/g, '');
  const ipv4Tail = value.match(/:(\d+\.\d+\.\d+\.\d+)$/);
  if (ipv4Tail) {
    const ipv4 = ipv4ToInteger(ipv4Tail[1]);
    if (ipv4 === null) return null;
    value = `${value.slice(0, -ipv4Tail[1].length)}${((ipv4 >>> 16) & 0xffff).toString(16)}:${(ipv4 & 0xffff).toString(16)}`;
  }
  const halves = value.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null;
  const groups = [...left, ...Array(missing).fill('0'), ...right];
  if (groups.length !== 8 || groups.some(group => !/^[0-9a-f]{1,4}$/i.test(group))) return null;
  return groups.reduce((result, group) => (result << 16n) + BigInt(`0x${group}`), 0n);
}

function inIpv6Range(value, prefix, bits) {
  const prefixValue = ipv6ToBigInt(prefix);
  if (value === null || prefixValue === null) return false;
  const shift = 128n - BigInt(bits);
  return (value >> shift) === (prefixValue >> shift);
}

/** Returns true when an address is not safe for a public web crawl. */
export function isBlockedIpAddress(address) {
  const family = net.isIP(address);
  if (family === 4) {
    return [
      ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
      ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
      ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
      ['224.0.0.0', 4], ['240.0.0.0', 4]
    ].some(([base, bits]) => inIpv4Range(address, base, bits));
  }
  if (family === 6) {
    const value = ipv6ToBigInt(address);
    if (value === null) return true;
    if (value === 0n || value === 1n) return true;
    if (inIpv6Range(value, 'fc00::', 7) || inIpv6Range(value, 'fe80::', 10) || inIpv6Range(value, 'ff00::', 8) || inIpv6Range(value, '2001:db8::', 32)) return true;
    // IPv4-compatible and IPv4-mapped addresses can otherwise bypass the IPv4 checks.
    if (inIpv6Range(value, '::', 96) || inIpv6Range(value, '::ffff:0:0', 96)) {
      const mappedIpv4 = `${Number((value >> 24n) & 255n)}.${Number((value >> 16n) & 255n)}.${Number((value >> 8n) & 255n)}.${Number(value & 255n)}`;
      return isBlockedIpAddress(mappedIpv4);
    }
  }
  return false;
}

export function parseCrawlUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new UnsafeCrawlTargetError('Enter a valid public HTTP or HTTPS website address.');
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) {
    throw new UnsafeCrawlTargetError('Only public HTTP and HTTPS website addresses can be crawled.');
  }
  if (parsed.username || parsed.password) {
    throw new UnsafeCrawlTargetError('Website addresses containing login credentials are not allowed.');
  }
  if (parsed.hostname === 'localhost' || parsed.hostname.endsWith('.localhost') || isBlockedIpAddress(parsed.hostname)) {
    throw new UnsafeCrawlTargetError('Private, loopback and internal network addresses cannot be crawled.');
  }
  return parsed;
}

/**
 * Validates literal addresses immediately and resolves hostnames before every
 * outbound crawler request. DNS answers are short-lived cached so a large site
 * remains fast while a DNS rebinding attempt cannot silently become trusted.
 */
export class CrawlNetworkPolicy {
  constructor({ lookup = dnsLookup, cacheTtlMs = DNS_CACHE_TTL_MS } = {}) {
    this.lookup = lookup;
    this.cacheTtlMs = cacheTtlMs;
    this.cache = new Map();
  }

  assertStaticallySafeUrl(value) {
    return parseCrawlUrl(value).toString();
  }

  async assertSafePublicUrl(value) {
    const parsed = parseCrawlUrl(value);
    if (net.isIP(parsed.hostname)) return parsed.toString();

    const host = parsed.hostname.toLowerCase();
    const now = Date.now();
    const cached = this.cache.get(host);
    let addresses;
    if (cached && cached.expiresAt > now) {
      addresses = cached.addresses;
    } else {
      try {
        addresses = await this.lookup(host, { all: true, verbatim: true });
      } catch {
        throw new UnsafeCrawlTargetError('The website hostname could not be resolved safely.');
      }
      if (!Array.isArray(addresses) || addresses.length === 0) {
        throw new UnsafeCrawlTargetError('The website hostname could not be resolved safely.');
      }
      this.cache.set(host, { addresses, expiresAt: now + this.cacheTtlMs });
    }
    if (addresses.some(record => !record?.address || isBlockedIpAddress(record.address))) {
      throw new UnsafeCrawlTargetError('Private, loopback and internal network addresses cannot be crawled.');
    }
    return parsed.toString();
  }
}
