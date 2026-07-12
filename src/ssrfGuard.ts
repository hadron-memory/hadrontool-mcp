/**
 * SSRF guard for upstream MCP URLs. The conduit lives on the internal
 * Docker network next to hadron-server, Postgres, and the other capability
 * tools — a registered URL must never become a probe into them. Core
 * validates registrations too, but this tool is standalone and cannot
 * assume a well-behaved caller (defense in depth).
 *
 * Approach: resolve the hostname and refuse when ANY resolved address is
 * private/loopback/link-local/reserved, unless MCP_ALLOW_PRIVATE_NETWORKS
 * is set (dev + tests). Known limitation, documented in the README: the
 * check races DNS rebinding (resolve-then-connect); pinning the resolved
 * address through the SDK's fetch is a follow-up.
 */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { allowPrivateNetworks } from './config.js';
import { PrivateNetworkBlockedError, UpstreamUnreachableError, ValidationError } from './errors.js';

/** True for IPv4 addresses in private/loopback/link-local/reserved ranges. */
function isPrivateV4(addr: string): boolean {
  const octets = addr.split('.').map(Number);
  if (octets.length !== 4 || octets.some((o) => Number.isNaN(o))) return true; // malformed → refuse
  const [a, b] = octets;
  return (
    a === 0 || // 0.0.0.0/8
    a === 10 || // 10.0.0.0/8
    a === 127 || // 127.0.0.0/8
    (a === 100 && b >= 64 && b <= 127) || // 100.64.0.0/10 (CGNAT)
    (a === 169 && b === 254) || // 169.254.0.0/16 (link-local / cloud metadata)
    (a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12 (Docker default nets live here)
    (a === 192 && b === 168) || // 192.168.0.0/16
    (a === 192 && b === 0) || // 192.0.0.0/24 + 192.0.2.0/24 (special/test)
    (a === 198 && (b === 18 || b === 19)) || // 198.18.0.0/15 (benchmarking)
    a >= 224 // multicast + reserved + broadcast
  );
}

/**
 * Decode an IPv6 literal to its 16 octets, or null when unparseable.
 *
 * String matching on IPv6 text is a trap: `new URL()` canonicalizes
 * `::ffff:127.0.0.1` to the hex form `::ffff:7f00:1`, so any regex keyed on
 * the dotted-quad shape silently misses it (CVE-class SSRF bypass). We work
 * on the decoded bytes instead — the one representation an attacker cannot
 * reshape. Handles `::` compression, embedded dotted-quad in the low 32
 * bits, and zone ids.
 */
function ipv6ToBytes(addr: string): number[] | null {
  let s = addr.toLowerCase();
  const zone = s.indexOf('%');
  if (zone !== -1) s = s.slice(0, zone); // drop the scope id (fe80::1%eth0)

  const halves = s.split('::');
  if (halves.length > 2) return null; // at most one '::'

  const parseGroups = (part: string): number[] | null => {
    if (part === '') return [];
    const tokens = part.split(':');
    const bytes: number[] = [];
    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i];
      if (tok.includes('.')) {
        // Embedded IPv4 — only legal as the final group (low 32 bits).
        if (i !== tokens.length - 1) return null;
        const octets = tok.split('.');
        if (octets.length !== 4) return null;
        for (const o of octets) {
          if (!/^\d{1,3}$/.test(o)) return null;
          const n = Number(o);
          if (n > 255) return null;
          bytes.push(n);
        }
      } else {
        if (!/^[0-9a-f]{1,4}$/.test(tok)) return null;
        const n = parseInt(tok, 16);
        bytes.push((n >> 8) & 0xff, n & 0xff);
      }
    }
    return bytes;
  };

  const head = parseGroups(halves[0]);
  if (head === null) return null;
  if (halves.length === 2) {
    const tail = parseGroups(halves[1]);
    if (tail === null) return null;
    const missing = 16 - head.length - tail.length;
    if (missing < 0) return null; // '::' must stand for at least one zero group
    return [...head, ...new Array(missing).fill(0), ...tail];
  }
  return head.length === 16 ? head : null; // no '::' → must be fully specified
}

/** True for IPv6 addresses that are loopback/link-local/unique-local, or that embed a private IPv4. */
function isPrivateV6(addr: string): boolean {
  const b = ipv6ToBytes(addr);
  if (b === null || b.length !== 16) return true; // unparseable → refuse
  const zeros = (from: number, to: number): boolean => b.slice(from, to).every((x) => x === 0);
  const embeddedV4 = (): boolean => isPrivateV4(b.slice(12, 16).join('.'));

  // fe80::/10 link-local
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return true;
  // fc00::/7 unique-local
  if ((b[0] & 0xfe) === 0xfc) return true;
  // ::ffff:0:0/96 IPv4-mapped → judge the embedded IPv4
  if (zeros(0, 10) && b[10] === 0xff && b[11] === 0xff) return embeddedV4();
  // ::/96 — unspecified (::), loopback (::1), and deprecated IPv4-compatible
  if (zeros(0, 12)) return embeddedV4();
  // 64:ff9b::/96 NAT64 well-known prefix → judge the embedded IPv4
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && zeros(4, 12)) return embeddedV4();

  return false;
}

/** True when a single literal or resolved address is private in its family. */
export function isPrivateAddress(addr: string): boolean {
  const family = isIP(addr);
  if (family === 4) return isPrivateV4(addr);
  if (family === 6) return isPrivateV6(addr);
  return true; // not an IP at all → refuse
}

/**
 * Validate an upstream MCP URL and enforce the private-network policy.
 * Throws ValidationError / PrivateNetworkBlockedError / UpstreamUnreachableError.
 */
export async function assertAllowedUpstream(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ValidationError('url must be an absolute URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new ValidationError('url must be http(s)');
  }
  if (url.username || url.password) {
    throw new ValidationError('url must not embed credentials — use headers');
  }
  if (allowPrivateNetworks()) return url;

  const host = url.hostname.replace(/^\[|\]$/g, ''); // strip IPv6 brackets
  let addresses: string[];
  if (isIP(host)) {
    addresses = [host];
  } else {
    try {
      const results = await lookup(host, { all: true, verbatim: true });
      addresses = results.map((r) => r.address);
    } catch (err) {
      throw new UpstreamUnreachableError(`DNS lookup failed for ${host}: ${String((err as Error)?.message ?? err)}`);
    }
  }
  if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
    throw new PrivateNetworkBlockedError(url.hostname);
  }
  return url;
}
