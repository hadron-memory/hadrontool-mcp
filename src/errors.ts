/**
 * Typed error catalog — the conduit's public contract. hadron-server's
 * mcpToolClient passes these codes through to GraphQL extensions /
 * run-hop failures verbatim, so their meanings must stay stable. New
 * codes may be added; existing ones never change meaning.
 */

/** Base class: every conduit error carries a stable `code` + HTTP status. */
export abstract class McpConduitError extends Error {
  abstract readonly code: string;
  abstract readonly httpStatus: number;

  /** JSON body shape every error response uses. */
  toBody(): Record<string, unknown> {
    return { error: this.code, message: this.message };
  }
}

/** Input failed schema or semantic validation. */
export class ValidationError extends McpConduitError {
  readonly code = 'validation_error';
  readonly httpStatus = 400;
  constructor(reason: string) {
    super(`This request couldn't be processed: ${reason}`);
  }
}

/** The upstream URL resolves to a private/loopback/link-local address. */
export class PrivateNetworkBlockedError extends McpConduitError {
  readonly code = 'private_network_blocked';
  readonly httpStatus = 400;
  constructor(host: string) {
    super(`The MCP server host "${host}" resolves to a private network address, which this conduit refuses.`);
  }
}

/** TCP/TLS/DNS failure before any MCP exchange completed. */
export class UpstreamUnreachableError extends McpConduitError {
  readonly code = 'upstream_unreachable';
  readonly httpStatus = 502;
  constructor(detail?: string) {
    super(`The external MCP server is unreachable${detail ? ` (${detail})` : ''}.`);
  }
}

/** The upstream did not answer within the per-request budget. */
export class UpstreamTimeoutError extends McpConduitError {
  readonly code = 'upstream_timeout';
  readonly httpStatus = 504;
  constructor() {
    super('The external MCP server timed out.');
  }
}

/** The upstream answered, but not with valid MCP (or with a protocol-level error). */
export class UpstreamProtocolError extends McpConduitError {
  readonly code = 'upstream_protocol_error';
  readonly httpStatus = 502;
  constructor(detail: string) {
    super(`The external MCP server returned a protocol error: ${detail}`);
  }
}
