/**
 * Environment configuration, validated once at import time (the
 * hadrontool-pdf / ms-exchange posture): fail LOUD at boot in production
 * for anything the service cannot safely run without; degrade gracefully
 * in development. This tool is STATELESS — no database, no encryption
 * keys, no per-connection state. Everything it needs to reach an external
 * MCP server (URL + static headers) arrives on each request from
 * hadron-server, which owns the registry and has already authorized the
 * call.
 */
import 'dotenv/config';

/** True when NODE_ENV is production. */
export const isProduction = process.env.NODE_ENV === 'production';

/** Read an env var, trimmed; empty string counts as unset. */
function env(name: string): string | undefined {
  const v = process.env[name]?.trim();
  return v === '' ? undefined : v;
}

/** Read a required-in-production env var; throws at boot when missing there. */
function required(name: string): string | undefined {
  const v = env(name);
  if (!v && isProduction) {
    throw new Error(`${name} is required in production — refusing to start`);
  }
  return v;
}

export const config = {
  port: Number(env('PORT') ?? 8080),

  /** Bearer token gating /ops/* and /info. Required in production. */
  toolToken: required('MCP_TOOL_TOKEN'),

  /** Per-request budget for an upstream tools/list (ms). */
  listTimeoutMs: Number(env('MCP_LIST_TIMEOUT_MS') ?? 25_000),

  /** Per-request budget for an upstream tools/call (ms). Keep it below
   *  core's mcpToolClient CALL_TIMEOUT_MS (60s) so the typed
   *  upstream_timeout wins over a blunt conduit-unreachable abort. */
  callTimeoutMs: Number(env('MCP_CALL_TIMEOUT_MS') ?? 55_000),

  maxBodySize: env('MAX_BODY_SIZE') ?? '2mb',
} as const;

/**
 * SSRF posture: private/loopback/link-local upstream addresses are refused
 * unless this flag is set. Read dynamically (not frozen at import) so
 * tests can exercise both sides; production deploys must leave it unset —
 * the conduit shares a Docker network with internal services, and a
 * registered URL must never become a probe into them.
 */
export function allowPrivateNetworks(): boolean {
  return (process.env.MCP_ALLOW_PRIVATE_NETWORKS ?? '').trim().toLowerCase() === 'true';
}
