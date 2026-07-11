# hadrontool-mcp

**A stateless MCP conduit for the Hadron platform**: it lets hadron-server's
headless runs (spec 040) call tools on **external MCP servers** — any remote
[Model Context Protocol](https://modelcontextprotocol.io) server speaking
Streamable HTTP — without hadron-server itself speaking MCP-as-a-client.

This is the fifth Hadron capability tool (pdf → ms-exchange → telegram →
slack → mcp), and deliberately the simplest kind: **no database, no
secrets at rest, no state**. Core (hadron-server) owns the registry of
external servers, the encrypted static headers, and ALL authorization —
every call arriving here has already passed the platform's policy chain.
This tool validates shape, enforces the network policy, and speaks the
protocol. (The Hadron-blind capability-tool boundary, spec cor:int:030:01.)

## How a call flows

```
flow node data.tools: ["mcp__everart__generate_image"]
        │
hadron-server run kernel
  • policy chain: checkActivation('tool.mcp__everart__generate_image')
  • action budget: cost 1
  • McpServer registry row (org-scoped): url + decrypted headers + allowlist
        │  POST /ops/call-tool { url, headers, name, arguments }
hadrontool-mcp (this service)
  • bearer gate, zod shape validation, SSRF guard
  • fresh MCP session: initialize → tools/call → close
        │  Streamable HTTP
external MCP server (third party)
```

## Operations plane (internal, bearer-gated)

| Route | Body | Returns |
|---|---|---|
| `POST /ops/list-tools` | `{ url, headers? }` | `{ tools: [{ name, description?, inputSchema }] }` |
| `POST /ops/call-tool` | `{ url, headers?, name, arguments? }` | `{ isError, content: [...] }` |
| `GET /info` | — | name, version, operations, transports |
| `GET /healthz` | — | liveness (public-safe) |

`isError: true` is a **tool-level** result the calling LLM should see
(standard MCP semantics) — it is returned with HTTP 200. Only transport,
protocol, and policy failures use the typed error codes:
`validation_error` (400), `private_network_blocked` (400),
`upstream_unreachable` (502), `upstream_protocol_error` (502),
`upstream_timeout` (504).

## v1 scope (deliberate)

- **Streamable HTTP upstreams only.** No stdio (that would mean running
  arbitrary processes in Hadron's infrastructure) and no legacy HTTP+SSE.
- **Static-header auth only.** The v1 story for authenticated servers is
  an `Authorization` header registered (encrypted) in core. MCP OAuth 2.1
  with dynamic client registration is a known v2 — it would make this tool
  secrets-bearing and stateful (the ms-exchange shape).
- **One session per request.** initialize → operate → close. No session
  reuse, no subscriptions, no server-initiated features (sampling,
  elicitation, roots are not offered).
- **SSRF guard.** Upstream hosts resolving to private / loopback /
  link-local / reserved addresses are refused unless
  `MCP_ALLOW_PRIVATE_NETWORKS=true` (dev only — the conduit shares a
  Docker network with internal services). Known limitation: the check is
  resolve-then-connect and does not yet pin the resolved address, so a
  DNS-rebinding upstream could race it; address pinning is a follow-up.
- **Bounded responses.** Content blocks are capped (100 blocks, 200k chars
  per text block) so an upstream cannot flood a run hop's context.

## Environment

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `8080` | Listen port. |
| `MCP_TOOL_TOKEN` | none | Shared bearer for `/ops/*` + `/info`. Required in production (boot refuses without it); unset in dev disables the gate. |
| `MCP_LIST_TIMEOUT_MS` | `25000` | Per-request budget for an upstream `tools/list`. |
| `MCP_CALL_TIMEOUT_MS` | `55000` | Per-request budget for an upstream `tools/call` — keep below core's 60s client timeout. |
| `MCP_ALLOW_PRIVATE_NETWORKS` | unset | `true` disables the SSRF guard. Dev/tests only. |
| `MAX_BODY_SIZE` | `2mb` | Express JSON body cap. |

## Development

```bash
npm install
npm run dev        # tsx watch, port 8080
npm test           # vitest — real HTTP surface against a REAL in-process MCP server
npm run typecheck
```

The test suite spins up a genuine `@modelcontextprotocol/sdk` server
in-process (stateless Streamable HTTP) — no mocked protocol internals.

## Deployment

Komodo build → GHCR → `komodo_default`, Doppler-injected secrets (image
bakes the Doppler CLI; Komodo sets only `DOPPLER_TOKEN`). Internal-only:
no Traefik route, no DNS. hadron-server's Doppler config gains
`MCP_TOOL_URL=http://hadrontool-mcp:8080` + `MCP_TOOL_TOKEN`.
