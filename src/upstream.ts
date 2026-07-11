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

/** `tools/list` against the target (paginated upstreams are drained). */
export async function listUpstreamTools(target: UpstreamTarget): Promise<UpstreamToolDefinition[]> {
  return withUpstream(target, async (client) => {
    const tools: UpstreamToolDefinition[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined, { timeout: config.listTimeoutMs });
      for (const t of page.tools) {
        tools.push({
          name: t.name,
          ...(t.description ? { description: t.description } : {}),
          inputSchema: (t.inputSchema as Record<string, unknown>) ?? { type: 'object' },
        });
      }
      cursor = page.nextCursor;
    } while (cursor && tools.length < 1000); // hard page cap — never loop forever
    return tools;
  });
}

/** Per-block text cap — an upstream must not flood a run hop's context. */
const MAX_TEXT_LENGTH = 200_000;
/** Content-block count cap, same rationale. */
const MAX_BLOCKS = 100;

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
    const bounded = blocks.slice(0, MAX_BLOCKS).map((block) => {
      if (block.type === 'text' && typeof block.text === 'string' && block.text.length > MAX_TEXT_LENGTH) {
        return { ...block, text: `${block.text.slice(0, MAX_TEXT_LENGTH)}\n[truncated by hadrontool-mcp]` };
      }
      return block;
    });
    return { isError: result.isError === true, content: bounded };
  });
}
