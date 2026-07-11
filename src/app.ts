/**
 * Express app factory (no injected dependencies — the tool is stateless;
 * tests run the real HTTP surface against a real in-process MCP upstream).
 *
 * Route map:
 *   GET  /healthz               liveness (public-safe, no secrets)
 *   GET  /info                  capabilities (bearer-gated)
 *   POST /ops/list-tools        operations plane (bearer-gated, internal)
 *   POST /ops/call-tool         operations plane (bearer-gated, internal)
 *
 * NOTHING here needs public ingress — the conduit initiates all upstream
 * connections itself (unlike ms-exchange's webhook route).
 */
import express, { type Express } from 'express';
import { config } from './config.js';
import { requireToolToken } from './middleware/auth.js';
import { opsRouter } from './routes/ops.js';

/** Package version, surfaced on /info. */
const VERSION = process.env.npm_package_version ?? '0.1.0';

/** Build the app. */
export function createApp(): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: config.maxBodySize }));

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true });
  });

  app.get('/info', requireToolToken, (_req, res) => {
    res.json({
      name: 'hadrontool-mcp',
      version: VERSION,
      operations: ['list-tools', 'call-tool'],
      transports: ['streamable-http'],
      stateless: true,
    });
  });

  app.use('/ops', requireToolToken, opsRouter());

  return app;
}
