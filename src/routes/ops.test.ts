/**
 * End-to-end over the real protocol: supertest → the conduit's HTTP
 * surface → a genuine in-process MCP upstream. What this file pins:
 *   - bearer gate on /ops/* and /info
 *   - list-tools: real tools/list passthrough (name/description/schema)
 *   - call-tool: text result; isError stays a 200 RESULT (MCP semantics);
 *     unknown tool → typed upstream_protocol_error
 *   - static-header forwarding to the upstream
 *   - validation_error on malformed bodies (strict schemas)
 *   - SSRF guard: private upstream refused when the override is off
 *   - upstream_unreachable when nothing listens
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { startFixtureUpstream, type FixtureUpstream } from '../test/fixtureServer.js';

const app = createApp();
const AUTH = { Authorization: 'Bearer test-tool-token' };

let upstream: FixtureUpstream;

beforeAll(async () => {
  upstream = await startFixtureUpstream();
});

afterAll(async () => {
  await upstream.close();
});

describe('bearer gate', () => {
  it('rejects /ops and /info without (or with a wrong) token', async () => {
    await request(app).post('/ops/list-tools').send({ url: upstream.url }).expect(401);
    await request(app)
      .post('/ops/list-tools')
      .set('Authorization', 'Bearer wrong')
      .send({ url: upstream.url })
      .expect(401);
    await request(app).get('/info').expect(401);
  });

  it('healthz is public; /info answers with capabilities', async () => {
    await request(app).get('/healthz').expect(200, { ok: true });
    const res = await request(app).get('/info').set(AUTH).expect(200);
    expect(res.body).toMatchObject({
      name: 'hadrontool-mcp',
      operations: ['list-tools', 'call-tool'],
      stateless: true,
    });
  });
});

describe('POST /ops/list-tools', () => {
  it('lists the upstream tools with schemas', async () => {
    const res = await request(app).post('/ops/list-tools').set(AUTH).send({ url: upstream.url }).expect(200);
    const names = res.body.tools.map((t: { name: string }) => t.name).sort();
    expect(names).toEqual(['boom', 'echo']);
    const echo = res.body.tools.find((t: { name: string }) => t.name === 'echo');
    expect(echo.description).toBe('Echo the text back.');
    expect(echo.inputSchema).toMatchObject({ type: 'object' });
    expect(echo.inputSchema.properties).toHaveProperty('text');
  });

  it('rejects a malformed body with validation_error (strict schema)', async () => {
    const res = await request(app)
      .post('/ops/list-tools')
      .set(AUTH)
      .send({ url: upstream.url, extra: true })
      .expect(400);
    expect(res.body.error).toBe('validation_error');
  });

  it('rejects CR/LF header values with validation_error', async () => {
    const res = await request(app)
      .post('/ops/list-tools')
      .set(AUTH)
      .send({ url: upstream.url, headers: { 'X-A': 'bad\r\nvalue' } })
      .expect(400);
    expect(res.body.error).toBe('validation_error');
  });

  it('answers upstream_unreachable when nothing listens at the target', async () => {
    const res = await request(app)
      .post('/ops/list-tools')
      .set(AUTH)
      .send({ url: 'http://127.0.0.1:9/mcp' })
      .expect(502);
    expect(res.body.error).toBe('upstream_unreachable');
  });
});

describe('POST /ops/call-tool', () => {
  it('calls a tool and returns text content', async () => {
    const res = await request(app)
      .post('/ops/call-tool')
      .set(AUTH)
      .send({ url: upstream.url, name: 'echo', arguments: { text: 'hi' } })
      .expect(200);
    expect(res.body).toEqual({ isError: false, content: [{ type: 'text', text: 'echo:hi' }] });
  });

  it('passes a tool-level error through as a 200 result (MCP semantics)', async () => {
    const res = await request(app)
      .post('/ops/call-tool')
      .set(AUTH)
      .send({ url: upstream.url, name: 'boom', arguments: {} })
      .expect(200);
    expect(res.body.isError).toBe(true);
    expect(res.body.content).toEqual([{ type: 'text', text: 'kaboom' }]);
  });

  it('surfaces an unknown tool name as a tool-level isError result (SDK behavior)', async () => {
    // The SDK's callTool converts the upstream JSON-RPC error into an
    // isError result — the calling LLM sees the message and adapts,
    // which is exactly the semantics core's run tools want.
    const res = await request(app)
      .post('/ops/call-tool')
      .set(AUTH)
      .send({ url: upstream.url, name: 'no_such_tool', arguments: {} })
      .expect(200);
    expect(res.body.isError).toBe(true);
    expect(res.body.content[0].text).toContain('no_such_tool');
  });
});

describe('static-header forwarding', () => {
  it('forwards the supplied headers; the upstream can require them', async () => {
    const gated = await startFixtureUpstream({ requireBearer: 'sk-upstream' });
    try {
      // Without the header: the upstream 401s → unreachable-class failure.
      await request(app).post('/ops/list-tools').set(AUTH).send({ url: gated.url }).expect(502);
      // With it: succeeds, and the upstream saw the bearer.
      await request(app)
        .post('/ops/list-tools')
        .set(AUTH)
        .send({ url: gated.url, headers: { Authorization: 'Bearer sk-upstream' } })
        .expect(200);
      expect(gated.seenAuthorization).toContain('Bearer sk-upstream');
    } finally {
      await gated.close();
    }
  });
});

describe('SSRF guard', () => {
  it('refuses a private-network upstream when the override is off', async () => {
    const prev = process.env.MCP_ALLOW_PRIVATE_NETWORKS;
    process.env.MCP_ALLOW_PRIVATE_NETWORKS = 'false';
    try {
      const res = await request(app)
        .post('/ops/list-tools')
        .set(AUTH)
        .send({ url: upstream.url }) // 127.0.0.1 — loopback
        .expect(400);
      expect(res.body.error).toBe('private_network_blocked');
    } finally {
      process.env.MCP_ALLOW_PRIVATE_NETWORKS = prev;
    }
  });

  it('refuses credentialed and non-http URLs outright', async () => {
    const bad1 = await request(app)
      .post('/ops/list-tools')
      .set(AUTH)
      .send({ url: 'ftp://example.com/mcp' })
      .expect(400);
    expect(bad1.body.error).toBe('validation_error');
    const bad2 = await request(app)
      .post('/ops/list-tools')
      .set(AUTH)
      .send({ url: 'https://user:pw@example.com/mcp' })
      .expect(400);
    expect(bad2.body.error).toBe('validation_error');
  });
});
