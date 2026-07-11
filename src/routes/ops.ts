/**
 * The operations plane: two bearer-gated, internal-only endpoints.
 *
 *   POST /ops/list-tools  { url, headers? }                    → { tools }
 *   POST /ops/call-tool   { url, headers?, name, arguments? }  → { isError, content }
 *
 * No authorization happens here — hadron-server has already walked the
 * policy chain and decrypted the registered headers before calling
 * (cor:int:030:01, the Hadron-blind capability-tool boundary). This tool
 * validates SHAPE and enforces the network policy, nothing tenant-aware.
 */
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { McpConduitError, ValidationError } from '../errors.js';
import { logError } from '../logger.js';
import { callUpstreamTool, listUpstreamTools } from '../upstream.js';

/** RFC 9110 field-name token; values must be CR/LF-free (request splitting). */
const headerSchema = z
  .record(z.string().min(1).max(128).regex(/^[!#$%&'*+\-.^_`|~A-Za-z0-9]+$/), z.string().max(4096))
  .refine((h) => Object.keys(h).length <= 32, 'too many headers')
  .refine((h) => Object.values(h).every((v) => !/[\r\n]/.test(v)), 'header values must not contain CR/LF');

const targetSchema = {
  url: z.string().min(1).max(2048),
  headers: headerSchema.optional(),
};

const listToolsSchema = z.object(targetSchema).strict();

const callToolSchema = z
  .object({
    ...targetSchema,
    name: z.string().min(1).max(256),
    arguments: z.record(z.unknown()).optional(),
  })
  .strict();

function sendError(res: Response, err: unknown): void {
  if (err instanceof McpConduitError) {
    res.status(err.httpStatus).json(err.toBody());
    return;
  }
  logError('unexpected ops failure:', err);
  res.status(500).json({ error: 'internal_error', message: 'Unexpected conduit failure.' });
}

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new ValidationError(result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  }
  return result.data;
}

/** Build the /ops router. */
export function opsRouter(): Router {
  const router = Router();

  router.post('/list-tools', async (req: Request, res: Response) => {
    try {
      const input = parse(listToolsSchema, req.body);
      const tools = await listUpstreamTools({ url: input.url, headers: input.headers });
      res.json({ tools });
    } catch (err) {
      sendError(res, err);
    }
  });

  router.post('/call-tool', async (req: Request, res: Response) => {
    try {
      const input = parse(callToolSchema, req.body);
      const result = await callUpstreamTool(
        { url: input.url, headers: input.headers },
        input.name,
        input.arguments ?? {},
      );
      res.json(result);
    } catch (err) {
      sendError(res, err);
    }
  });

  return router;
}
