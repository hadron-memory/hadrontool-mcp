/**
 * The SSRF guard is load-bearing — the conduit shares an internal Docker
 * network with core, Postgres, and the other tools, so a registered URL
 * must never resolve to one of them. These pin the decode-the-bytes policy
 * against the address forms an attacker actually reaches for, including the
 * ones `new URL()` canonicalizes into hex (the historic bypass class).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { assertAllowedUpstream, isPrivateAddress } from './ssrfGuard.js';
import { PrivateNetworkBlockedError } from './errors.js';

describe('isPrivateAddress — refused (private/loopback/link-local/embedded-v4)', () => {
  const blocked = [
    // IPv4 literals
    '127.0.0.1',
    '10.0.0.1',
    '172.17.0.1', // Docker default bridge
    '192.168.0.1',
    '169.254.169.254', // cloud metadata
    '100.64.0.1', // CGNAT
    '0.0.0.0',
    // IPv6 loopback / unspecified / link-local / unique-local
    '::1',
    '::',
    'fe80::1',
    'fc00::1',
    'fd12:3456::1',
    // IPv4-mapped, dotted form
    '::ffff:127.0.0.1',
    '::ffff:169.254.169.254',
    // IPv4-mapped, HEX form — what new URL() actually produces (the bypass)
    '::ffff:7f00:1', // 127.0.0.1
    '::ffff:a9fe:a9fe', // 169.254.169.254
    '::ffff:a00:1', // 10.0.0.1
    '::ffff:c0a8:101', // 192.168.1.1
    // Deprecated IPv4-compatible ::/96 and NAT64 embedding a private v4
    '::7f00:1', // ::127.0.0.1
    '64:ff9b::7f00:1', // NAT64 → 127.0.0.1
    // Not an IP at all
    'not-an-ip',
    '',
  ];
  it.each(blocked)('refuses %s', (addr) => {
    expect(isPrivateAddress(addr)).toBe(true);
  });
});

describe('isPrivateAddress — allowed (public)', () => {
  const allowed = [
    '8.8.8.8',
    '1.1.1.1',
    '93.184.216.34', // example.com
    '2606:4700:4700::1111', // Cloudflare
    '2001:4860:4860::8888', // Google
    '::ffff:8.8.8.8', // mapped, but public
    '::ffff:808:808', // mapped 8.8.8.8, hex
  ];
  it.each(allowed)('allows %s', (addr) => {
    expect(isPrivateAddress(addr)).toBe(false);
  });
});

describe('assertAllowedUpstream — end to end with the override off', () => {
  const prev = process.env.MCP_ALLOW_PRIVATE_NETWORKS;
  afterEach(() => {
    process.env.MCP_ALLOW_PRIVATE_NETWORKS = prev;
  });

  it('blocks an IPv4-mapped-loopback URL that canonicalizes to hex', async () => {
    process.env.MCP_ALLOW_PRIVATE_NETWORKS = 'false';
    await expect(assertAllowedUpstream('http://[::ffff:127.0.0.1]:8080/mcp')).rejects.toBeInstanceOf(
      PrivateNetworkBlockedError,
    );
    await expect(assertAllowedUpstream('http://[::1]/mcp')).rejects.toBeInstanceOf(PrivateNetworkBlockedError);
  });

  it('still allows a public IPv6 literal', async () => {
    process.env.MCP_ALLOW_PRIVATE_NETWORKS = 'false';
    const url = await assertAllowedUpstream('http://[2606:4700:4700::1111]/mcp');
    expect(url.hostname).toBe('[2606:4700:4700::1111]');
  });
});
