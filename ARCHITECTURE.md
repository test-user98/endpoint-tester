# Architecture

## Design Overview

The agent uses a **concurrent multi-agent architecture** with three phases:

```
Phase 0: Routing Discovery
  List connected accounts → probe each path prefix → cache {accountId, baseUrl} per prefix

Phase 1+2 (concurrent): Per-Endpoint Agents
  All 16 agents launch simultaneously via Promise.all
  Agents without path params execute immediately
  Agents with path params await their provider's deferred signal, then execute
```

Each endpoint gets its own independent agent function. There is no hardcoded execution order — dependency resolution happens dynamically through deferred promises (signals). When a list endpoint finishes and caches its resources, it resolves its signal, waking up any dependent detail/action endpoints.

### Module Structure

```
src/
├── agent.ts          — Orchestrator + per-endpoint agent + retry logic
├── routing.ts        — Auto-discover connected accounts + URL format per toolkit
├── resource-cache.ts — Shared resource cache with smart ID extraction
├── body-builder.ts   — Generic request body construction from field definitions
├── classifier.ts     — Response classification + sanitization
└── logger.ts         — Structured debug logging (writes to debug.log)
```

## Dependency Resolution

The core challenge: endpoints like `GET /messages/{messageId}` can't be called without first obtaining a valid ID from `GET /messages`.

**Strategy: Deferred Signals + Shared Resource Cache**

1. At startup, every endpoint without path parameters registers a deferred signal (a Promise + its resolve function) keyed by its path.
2. All agents launch concurrently. Agents with path params call `await signal.promise` for their base path (derived by stripping everything from the first `{param}` onward).
3. When a provider endpoint (e.g., LIST_MESSAGES) completes successfully, it caches extracted resources and resolves its signal.
4. Dependent agents wake up, query the cache for the param they need, and continue.

**Resource extraction is generic** — the cache doesn't know about Gmail or Calendar. It scores array fields in the response by:
- Whether items have an `id` field (+10)
- Whether the key is a standard list name like `items`, `messages`, `events` (+5)
- Array length (+1 per item, max 5)

This avoids the bug of caching metadata arrays (like `defaultReminders`) over actual resource arrays.

**ID resolution** tries the exact param name first (e.g., `messageId`), then falls back to common fields: `id`, `uid`, `uuid`, `key`, `slug`. For destructive operations (DELETE), the resolver preferentially picks unused resources to avoid conflicts with concurrent read operations.

**Fallback**: If no data is available (empty list, provider failed), a placeholder ID is used. The agent then checks whether the resulting 404 is a *structured API error* (endpoint exists, resource not found) vs a *generic 404* (endpoint doesn't exist).

## Avoiding False Negatives

This is the hardest part. A valid endpoint misclassified as invalid because the agent sent a bad request is worse than admitting uncertainty.

### Body Construction (body-builder.ts)

For POST/PUT/PATCH endpoints, the agent generates **multiple body variations** and tries them in order:

1. **Full required fields** — all required fields with values inferred from type + description
2. **Simplified** — object fields replaced with `{ value: "test" }` (catches over-complex inference)
3. **With optionals** — all fields including optional ones (some APIs require them)
4. **Empty body** — some endpoints accept empty POST

The agent stops on the first 2xx or a definitive non-retriable status (404, 403).

**Field value inference** reads the `type` and `description` to generate valid data:
- Detects "RFC 2822" + "base64" → generates a base64url-encoded email
- Detects "RFC3339" → generates an ISO datetime
- Detects quoted sub-field names in object descriptions (e.g., `'dateTime'` and `'timeZone'`)
- Uses field name context (e.g., "start" vs "end") to offset datetimes

### Retry with Backoff

Transient failures (429, 5xx, network errors) get 3 retries with exponential backoff (1s, 2s, 4s). This prevents rate-limit-induced false negatives.

### Placeholder ID Analysis

When a path parameter can't be resolved and a placeholder is used, the agent doesn't blindly classify a 404 as `invalid_endpoint`. It checks if the 404 response is a structured API error (JSON with error code/message), which indicates the endpoint exists — only the specific resource wasn't found.

## Classification Logic (classifier.ts)

```
HTTP 2xx                              → valid
HTTP 404 / 405                        → invalid_endpoint
HTTP 404 + structured error + placeholder → error (endpoint exists, can't test it)
HTTP 401 / 403                        → insufficient_scopes
Response body contains "forbidden",
  "insufficient", "permission denied" → insufficient_scopes
Response body contains "not found",
  "method not allowed"                → invalid_endpoint
Proxy/network error                   → error (with isProxyError flag)
Everything else (400, 500, etc.)      → error
```

The classifier explicitly distinguishes **proxy errors** (Composio infrastructure issues) from **API errors** (the target API responded). This affects the response summary — proxy errors say "infrastructure error", API errors say "request could not be completed".

## Routing Discovery (routing.ts)

A production-grade agent can't assume a single `connectedAccountId` works for all endpoints. Different toolkits (Gmail, Calendar, Stripe, Jira) each have their own connected account and may require different URL formats.

**The discovery phase** runs before any endpoint testing:

1. List all active connected accounts
2. For each unique path prefix (e.g., `/gmail/v1`, `/calendar/v3`), probe with each account
3. If a relative path returns an HTML 404 (routing issue), try full URL formats
4. Cache the working `{accountId, baseUrl}` per prefix

This is fully generic — it doesn't know about Gmail or Calendar. It dynamically discovers which account and URL format works for any API.

## Structured Logging (logger.ts)

Every action is logged to `debug.log` with:
- ISO timestamp
- Log level (INFO, DEBUG, WARN, ERROR, TRACE)
- Endpoint slug (for filtering)
- Phase tag (start, dependency, routing, request, body-try, classify, result, retry, cache, fatal)
- Message + optional structured data
- Request duration (for TRACE entries)

Example:
```
[2026-03-28T07:32:22.654Z] [INFO ] [GMAIL_GET_MESSAGE] [dependency] Resolved {messageId} = "19d1b2ff8f72b035"
[2026-03-28T07:32:22.900Z] [TRACE] [GMAIL_GET_MESSAGE] [request] Attempt 1/3: GET /gmail/v1/users/me/messages/19d1b2ff8f72b035 → HTTP 200 (246ms)
```

This makes debugging straightforward: filter by endpoint slug to trace exactly what the agent tried, what it got back, and why it classified the way it did.

## Tradeoffs

### What I chose and why

- **Concurrent over sequential**: All agents run simultaneously. Dependencies are resolved through promise chains, not hardcoded phases. This is faster and more architecturally sound, but adds complexity around signal management and cache consistency.

- **Description-based body inference over LLM-based**: Parsing field descriptions with regex/heuristics is fast, deterministic, and free. An LLM could generate better payloads for complex schemas, but adds latency, cost, and non-determinism.

- **Multiple body variations over single attempt**: Trying 2-4 body variations per POST endpoint adds a few extra API calls but dramatically reduces false negatives. A valid endpoint with a complex schema is much more likely to succeed on at least one variation.

- **Routing discovery over hardcoded accounts**: The probe phase adds ~2-4 seconds at startup but makes the agent truly generic across any Composio-connected API.

### What I'd improve with more time

1. **LLM-assisted body construction** — For complex schemas with deeply nested objects, an LLM could generate better payloads than regex parsing. Could use it as a fallback when heuristic bodies all fail.

2. **Multi-level dependency resolution** — Currently handles one level of dependencies (list → detail). For APIs with deeper chains (e.g., `org → repo → issue → comment`), would need topological sorting or recursive resolution.

3. **Scope inference from account metadata** — Currently `available_scopes` is inferred from which endpoints succeed. Could query the Composio API for the actual granted scopes.

4. **Parallel routing discovery** — Currently probes prefixes sequentially. Could parallelize for faster startup.

5. **Response body validation** — Currently any 2xx = valid. Could do basic schema validation to catch edge cases where the API returns 200 but with an error body.

## Architecture Pattern: Why Concurrent Multi-Agent

**Pros:**
- No hardcoded execution order — generalizes to any endpoint set
- Fast — all independent endpoints test simultaneously
- Clean separation — each agent is self-contained with its own error handling
- Scalable — adding more endpoints doesn't change the architecture

**Cons:**
- Promise-based dependency resolution is more complex than sequential phases
- Shared mutable cache requires careful design (though JS single-threading helps)
- Signal management needs robust `finally` blocks to prevent deadlocks

The alternative (sequential loop) would be simpler but slower and architecturally rigid. The multi-agent pattern matches the problem structure: each endpoint is an independent verification task with optional data dependencies.
