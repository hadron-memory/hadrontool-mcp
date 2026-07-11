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

/** True for IPv6 addresses that are loopback/link-local/unique-local/v4-mapped-private. */
function isPrivateV6(addr: string): boolean {
  const lower = addr.toLowerCase();
  if (lower === '::' || lower === '::1') return true;
  if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) {
    return true; // fe80::/10 link-local
  }
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // fc00::/7 unique-local
  // IPv4-mapped (::ffff:a.b.c.d) — apply the v4 rules to the embedded address.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped) return isPrivateV4(mapped[1]);
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
