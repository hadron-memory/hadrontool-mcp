/**
 * The one MCP-speaking module: a fresh client session per request
 * (initialize → operate → close). STATELESS BY DESIGN — v1 targets
 * Streamable-HTTP servers with static-header auth; per-connection OAuth
 * and long-lived sessions are explicitly out of scope (they would make
 * this tool secrets-bearing and stateful, the ms-exchange shape, which
 * the platform deliberately avoided here).
 *
 * Server-initiated MCP features (sampling, elicitation, roots) are not
 * declared in the client capabilities and have no handlers — a headless
 * run has no user to elicit from; upstreams that require them fail their
 * request, typed.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { config } from './config.js';
import { UpstreamProtocolError, UpstreamTimeoutError, UpstreamUnreachableError, type McpConduitError } from './errors.js';
import { assertAllowedUpstream } from './ssrfGuard.js';

/** What a request aims at: the registered server's URL + static headers. */
export interface UpstreamTarget {
  url: string;
  headers?: Record<string, string>;
}

/** One advertised tool, passed through to core verbatim. */
export interface UpstreamToolDefinition {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

/** MCP tools/call result: content blocks + the tool-level error flag. */
export interface UpstreamCallResult {
  isError: boolean;
  content: Array<Record<string, unknown>>;
}

/** Map an SDK/transport failure to the typed catalog. */
function mapUpstreamError(err: unknown): McpConduitError {
  if (err instanceof McpError) {
    if (err.code === ErrorCode.RequestTimeout) return new UpstreamTimeoutError();
    if (err.code === ErrorCode.ConnectionClosed) {
      return new UpstreamUnreachableError('connection closed');
    }
    return new UpstreamProtocolError(err.message);
  }
  const message = String((err as Error)?.message ?? err);
  // Transport-level failures (fetch TypeError, socket errors, non-2xx on
  // initialize) arrive as plain Errors from the transport layer.
  return new UpstreamUnreachableError(message.slice(0, 300));
}

/** Run `fn` inside a fresh MCP session against the target; always closes. */
async function withUpstream<T>(target: UpstreamTarget, fn: (client: Client) => Promise<T>): Promise<T> {
  const url = await assertAllowedUpstream(target.url);
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: target.headers ?? {} },
  });
  const client = new Client({ name: 'hadrontool-mcp', version: '0.1.0' });
  try {
    await client.connect(transport);
    return await fn(client);
  } catch (err) {
    // Typed guard errors (SSRF, validation) pass through untouched.
    if ((err as McpConduitError)?.code && (err as McpConduitError)?.httpStatus) throw err;
    throw mapUpstreamError(err);
  } finally {
    await client.close().catch(() => {});
  }
}

/** Accumulated-tool cap: stop draining once this many tools are collected. */
const MAX_TOOLS = 1000;
/** Page-count cap: a malicious upstream must not keep us draining forever. */
const MAX_LIST_PAGES = 50;

/**
 * Drain a cursor-paginated MCP list until it ends, guarding against an
 * upstream that never terminates. Two backstops beyond the item cap: a
 * repeated cursor (`{ items: [], nextCursor: "same" }` forever) fails typed,
 * and an unbounded run of fresh empty pages hits the page cap. Each page
 * still has its own per-request timeout; this bounds the loop *around* them.
 */
export async function drainPages<T>(
  fetchPage: (cursor: string | undefined) => Promise<{ items: T[]; nextCursor?: string }>,
  opts: { maxItems: number; maxPages: number },
): Promise<T[]> {
  const items: T[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  let pages = 0;
  do {
    const page = await fetchPage(cursor);
    items.push(...page.items);
    pages += 1;
    cursor = page.nextCursor;
    if (cursor !== undefined) {
      if (seenCursors.has(cursor)) {
        throw new UpstreamProtocolError('tools/list returned a repeated pagination cursor');
      }
      seenCursors.add(cursor);
    }
  } while (cursor !== undefined && items.length < opts.maxItems && pages < opts.maxPages);
  return items;
}

/** `tools/list` against the target (paginated upstreams are drained, bounded). */
export async function listUpstreamTools(target: UpstreamTarget): Promise<UpstreamToolDefinition[]> {
  return withUpstream(target, (client) =>
    drainPages<UpstreamToolDefinition>(
      async (cursor) => {
        const page = await client.listTools(cursor ? { cursor } : undefined, { timeout: config.listTimeoutMs });
        return {
          items: page.tools.map((t) => ({
            name: t.name,
            ...(t.description ? { description: t.description } : {}),
            inputSchema: (t.inputSchema as Record<string, unknown>) ?? { type: 'object' },
          })),
          nextCursor: page.nextCursor,
        };
      },
      { maxItems: MAX_TOOLS, maxPages: MAX_LIST_PAGES },
    ),
  );
}

/** Per-string cap — bounds any string field (text, base64 `data`, `_meta`), not just text blocks. */
const MAX_TEXT_LENGTH = 200_000;
/** Content-block count cap. */
const MAX_BLOCKS = 100;
/** Total serialized-response cap — the real backstop against unbounded aggregate payloads. */
const MAX_TOTAL_BYTES = 5_000_000;

/**
 * Recursively cap every string in a content block. A per-*text*-block cap
 * misses image/audio base64 `data`, `resource` `blob`/`text`, and `_meta`
 * — all of which an upstream can inflate. We walk the whole block instead.
 */
function boundStrings(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.length > MAX_TEXT_LENGTH ? `${value.slice(0, MAX_TEXT_LENGTH)}\n[truncated by hadrontool-mcp]` : value;
  }
  if (Array.isArray(value)) return value.map(boundStrings);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = boundStrings(v);
    return out;
  }
  return value;
}

/**
 * Enforce the "bounded responses" contract: cap block count, cap every
 * string, then cap the total serialized size (dropping trailing blocks with
 * a marker). This is what core relies on to keep a run hop's context sane.
 */
export function boundContent(rawBlocks: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const capped = rawBlocks.slice(0, MAX_BLOCKS).map((b) => boundStrings(b) as Record<string, unknown>);
  const bounded: Array<Record<string, unknown>> = [];
  let total = 0;
  for (const block of capped) {
    const size = JSON.stringify(block).length;
    if (bounded.length > 0 && total + size > MAX_TOTAL_BYTES) break;
    bounded.push(block);
    total += size;
  }
  const dropped = capped.length - bounded.length;
  if (dropped > 0) {
    bounded.push({
      type: 'text',
      text: `[hadrontool-mcp dropped ${dropped} content block(s): response exceeded ${MAX_TOTAL_BYTES} bytes]`,
    });
  }
  return bounded;
}

/** `tools/call` against the target. isError stays a RESULT, never an HTTP error. */
export async function callUpstreamTool(
  target: UpstreamTarget,
  name: string,
  args: Record<string, unknown>,
): Promise<UpstreamCallResult> {
  return withUpstream(target, async (client) => {
    const result = await client.callTool({ name, arguments: args }, undefined, {
      timeout: config.callTimeoutMs,
    });
    const blocks = Array.isArray(result.content) ? (result.content as Array<Record<string, unknown>>) : [];
    return { isError: result.isError === true, content: boundContent(blocks) };
  });
}
