# Agent dev guide — hadrontool-mcp

**hadrontool-mcp** is the Hadron platform's **generic MCP conduit**: a
stateless, DB-less capability tool that lets hadron-server's headless runs
(spec 040) call tools on external MCP servers (Streamable HTTP). Core owns
the org-scoped registry (`McpServer` rows), the encrypted static headers,
and ALL authorization (policy chain `tool.mcp__<slug>__<tool>` + action
budgets); this tool validates shape, enforces the SSRF network policy, and
speaks the protocol — one fresh session per request.

Design + scope: [README.md](README.md). Core-side integration:
hadron-server `src/lib/mcpToolClient.ts`, `src/lib/mcpServers.ts`,
`src/lib/runner/tools/mcpTools.ts`.

## Commands

```bash
npm run dev        # tsx watch (port 8080)
npm test           # vitest — real HTTP + a REAL in-process MCP upstream
npm run typecheck
```

No database. No prisma. Tests need no setup at all.

## Structure

- `src/upstream.ts` — the ONLY MCP-speaking module (SDK client, per-request
  session, error mapping, response bounding).
- `src/routes/ops.ts` — `POST /ops/list-tools` + `POST /ops/call-tool`
  (bearer-gated, zod-validated, strict schemas).
- `src/ssrfGuard.ts` — refuses private/loopback/link-local upstream hosts
  unless `MCP_ALLOW_PRIVATE_NETWORKS=true` (dev only).
- `src/errors.ts` — the typed public error catalog (codes are stable
  contract; hadron-server passes them through as `mcpErrorCode`).
- `src/test/fixtureServer.ts` — a genuine SDK MCP server the tests target.

## Key invariants

- **Hadron-blind (cor:int:030:01).** No tenant, org, run, or policy concept
  appears here. Never add authorization — core has already done it.
- **Stateless by design.** No session reuse, no connection rows, no secrets
  at rest. If a change needs any of those, it belongs in v2 (MCP OAuth) and
  changes the tool's shape — stop and design first.
- **`isError` is a RESULT (HTTP 200), never an HTTP error** — MCP tool-level
  errors are for the calling LLM to see. Typed HTTP errors are reserved for
  transport/protocol/policy failures.
- **Error codes are public contract.** hadron-server surfaces them verbatim;
  add codes, never change meanings.
- **The SSRF guard is load-bearing.** The conduit lives on `komodo_default`
  next to core, Postgres, and the other tools; a registered URL must never
  become a probe into them. `MCP_ALLOW_PRIVATE_NETWORKS` stays unset in prod.
- **Zod stays on v3** — the MCP SDK's schemas are zod-v3-typed; a v4 bump
  desyncs the fixture server's `registerTool` inputSchema types.

## Use of Hadron

This tool has no memory of its own — work against the shared ones:
`hrn:mem:hadronmemory.com:dev` (findings/conventions/ops + the
`preflight` routing index), `hrn:mem:hadronmemory.com:hadron-server`
(core integration), `hrn:mem:hadronmemory.com:specs` (platform specs).
Read `hrn:node:hadronmemory.com:dev:instructions` once per session; capture
non-obvious findings immediately.
