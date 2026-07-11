/**
 * A REAL MCP server the tests run in-process (stateless Streamable HTTP:
 * fresh server + transport per request, the SDK's documented stateless
 * pattern). The conduit's tests exercise the genuine protocol end to end —
 * no mocked SDK internals.
 */
import express from 'express';
import type { Server } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

export interface FixtureUpstream {
  url: string;
  /** Requests seen, for header-forwarding assertions. */
  seenAuthorization: Array<string | undefined>;
  close: () => Promise<void>;
}

/** Start the fixture; optionally demand a bearer (401 otherwise). */
export async function startFixtureUpstream(opts: { requireBearer?: string } = {}): Promise<FixtureUpstream> {
  const seenAuthorization: Array<string | undefined> = [];
  const app = express();
  app.use(express.json());

  app.post('/mcp', async (req, res) => {
    seenAuthorization.push(req.headers.authorization);
    if (opts.requireBearer && req.headers.authorization !== `Bearer ${opts.requireBearer}`) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }

    const server = new McpServer({ name: 'fixture-upstream', version: '1.0.0' });
    server.registerTool(
      'echo',
      {
        description: 'Echo the text back.',
        inputSchema: { text: z.string() },
      },
      async ({ text }) => ({ content: [{ type: 'text', text: `echo:${text}` }] }),
    );
    server.registerTool(
      'boom',
      {
        description: 'Always fails at the tool level.',
        inputSchema: { why: z.string().optional() },
      },
      async () => ({ isError: true, content: [{ type: 'text', text: 'kaboom' }] }),
    );

    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  const httpServer: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const address = httpServer.address();
  if (address === null || typeof address === 'string') throw new Error('fixture bind failed');

  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    seenAuthorization,
    close: () => new Promise((resolve) => httpServer.close(() => resolve())),
  };
}
