# hadrontool-mcp — architecture

Status: **implemented (v1)**. Decisions recorded 2026-07-11 (Holger, in
session): official `@modelcontextprotocol/sdk` client; static-header auth
encrypted in core; org-scoped registry as a core Prisma model; public repo.

## Where this sits

The fifth application of the capability-tool pattern (pdf → ms-exchange →
telegram → slack → mcp), and the simplest shape in the family:

|  | pdf | ms-exchange | **mcp (this)** |
|---|---|---|---|
| State | none | DB (tokens, subscriptions) | **none** |
| Secrets at rest | none | tool-owned encrypted tokens | **none — core owns them** |
| Planes | ops only | ops + events | **ops only** |
| Public ingress | none | one webhook route | **none** |

The asymmetry with ms-exchange is deliberate: MCP is a *protocol*, not a
*provider*. There is no provider account relationship to own, so the tool
can stay stateless and core keeps identity + governance + secrets — the
same division the one-tool-per-provider decision (2026-07-08) drew, applied
to a protocol conduit.

## Division of responsibility

**hadron-server (core) owns:**

- The registry: org-scoped `McpServer` rows (slug, URL, encrypted static
  headers via tokenCrypto, tool allowlist, enabled). Org-ADMIN GraphQL CRUD
  (`createMcpServer` / `updateMcpServer` / `deleteMcpServer`), uniform read
  surface (`mcpServer` / `mcpServers` / `mcpServerTools`).
- Authorization, entirely: a flow node declares `mcp__<slug>__<tool>` in
  `data.tools`; `loadNodeSpec` validates against the registry (grammar,
  registration, enabled, allowlist, 64-char provider cap) BEFORE any LLM
  call; every invocation walks the conjunctive policy chain as
  `tool.mcp__<slug>__<tool>` and costs 1 action from the run budget.
  Registration grants nothing by itself.
- Secrets: static headers are AES-256-GCM-encrypted in core, write-only on
  the API, decrypted per call, and shipped to this tool per request.

**This tool owns:**

- The protocol: one fresh MCP session per request (initialize → tools/list
  or tools/call → close) over Streamable HTTP, via the official TS SDK.
- The network policy: the SSRF guard (private/loopback/link-local refusal).
- Response bounding (block/text caps) and the typed error catalog.

## The run-time path

1. `loadNodeSpec` (core): static + registry validation, fail-loud (D-TL-6).
2. `llmTools` (core): live `POST /ops/list-tools` per referenced server —
   definitions come from the upstream at hop start, so a tool that
   vanished upstream fails the hop loud rather than silently running
   without it (D-TL-8 posture). Upstream descriptions are bounded (1k) and
   prefixed with the registered server name before entering the prompt.
3. Each LLM tool call: `checkActivation('tool.mcp__<slug>__<tool>')`
   (kill switch bites mid-hop), then `POST /ops/call-tool` here.
4. Result: text blocks flattened for the LLM; `isError: true` returns to
   the LLM as a result (it adapts); transport/protocol failures throw and
   terminate the hop as TOOL_FAILED.

## Trust posture (v1)

Upstream tool descriptions, schemas, and results are THIRD-PARTY CONTENT
entering a headless LLM's context — a prompt-injection surface the other
capability tools don't have (they normalize provider data into shapes core
defined). v1 mitigations: org-ADMIN registration + per-server allowlist is
the trust decision; every call is policy-gated and budget-metered; content
is bounded. Known follow-ups, in priority order:

1. **Tool-definition pinning** — hash the admitted tool list at
   registration; a changed upstream description requires re-approval
   (the rug-pull defense).
2. **DNS pinning in the SSRF guard** — resolve-then-connect currently
   races DNS rebinding; pin the resolved address through the transport's
   fetch.
3. **MCP OAuth 2.1** (dynamic client registration, token refresh) — makes
   the tool secrets-bearing + stateful; reuse the ms-exchange token
   lifecycle invariants when it lands.

## What was deliberately declined

- **stdio upstreams** — arbitrary process execution inside Hadron infra.
- **Session reuse / subscriptions** — statefulness without a payoff at
  current scale; a per-request session costs one initialize round-trip.
- **Sampling / elicitation / roots** — a headless run has no user; the
  client declares no such capabilities and upstreams requiring them fail
  typed.
- **A tool-side registry mirror** — two sources of truth for which servers
  exist would drift; the registry lives in core only.
