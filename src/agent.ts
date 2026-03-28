import { Composio } from "@composio/core";
import type { EndpointDefinition, TestReport, EndpointReport, EndpointStatus } from "./types";
import { initLogger, createEndpointLogger, type EndpointLogger } from "./logger";
import { ResourceCache, deriveListPath, findProviderEndpoint } from "./resource-cache";
import { generateBodyVariations, buildQueryParams } from "./body-builder";
import { discoverRouting, resolveEndpoint } from "./routing";
import {
  classify, isRetriable, isClientError, isStructuredApiError,
  sanitizeResponse, buildResponseSummary, type ApiResponse,
} from "./classifier";

// ─── Constants ────────────────────────────────────────────────────────────

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 3;
const BACKOFF_BASE_MS = 1_000;

// ─── Main Entry Point ─────────────────────────────────────────────────────

export async function runAgent(params: {
  composio: Composio;
  connectedAccountId: string;
  endpoints: EndpointDefinition[];
}): Promise<TestReport> {
  const { composio, endpoints } = params;

  initLogger();

  // Phase 0: Discover routing — auto-detect connected accounts and URL format
  // per path prefix. This replaces the hardcoded connectedAccountId.
  console.log("Discovering routing configuration...\n");
  const routing = await discoverRouting(composio, endpoints);

  const cache = new ResourceCache();

  // Deferred signals: endpoints without path params signal when done
  // so dependent endpoints can wait for their data providers.
  const signals = new Map<string, { promise: Promise<void>; resolve: () => void }>();

  for (const ep of endpoints) {
    if (ep.parameters.path.length === 0 && !signals.has(ep.path)) {
      let resolve!: () => void;
      const promise = new Promise<void>(r => { resolve = r; });
      signals.set(ep.path, { promise, resolve });
    }
  }

  // Launch ALL endpoint agents concurrently — no hardcoded execution order.
  // Agents with path params will await their provider's signal before executing.
  console.log(`Launching ${endpoints.length} endpoint agents concurrently...\n`);

  const results = await Promise.all(
    endpoints.map(ep =>
      runEndpointAgent({
        composio,
        endpoint: ep,
        cache,
        signals,
        allEndpoints: endpoints,
        routing,
      })
    ),
  );

  // Infer available scopes from successful endpoints
  const availableScopes = new Set<string>();
  for (const r of results) {
    if (r.status === "valid") {
      for (const scope of r.required_scopes) availableScopes.add(scope);
    }
  }
  for (const r of results) {
    r.available_scopes = [...availableScopes];
  }

  // Build summary
  const summary = { valid: 0, invalid_endpoint: 0, insufficient_scopes: 0, error: 0 };
  for (const r of results) summary[r.status]++;

  return {
    timestamp: new Date().toISOString(),
    total_endpoints: endpoints.length,
    results,
    summary,
  };
}

// ─── Per-Endpoint Agent ───────────────────────────────────────────────────

interface AgentContext {
  composio: Composio;
  endpoint: EndpointDefinition;
  cache: ResourceCache;
  signals: Map<string, { promise: Promise<void>; resolve: () => void }>;
  allEndpoints: EndpointDefinition[];
  routing: Map<string, { connectedAccountId: string; baseUrl: string }>;
}

async function runEndpointAgent(ctx: AgentContext): Promise<EndpointReport> {
  const { composio, endpoint, cache, signals, allEndpoints, routing } = ctx;
  const { tool_slug, method, path, parameters, required_scopes } = endpoint;
  const log = createEndpointLogger(tool_slug);
  const isDestructive = method === "DELETE";

  log.info("start", `Starting agent for ${method} ${path}`);

  try {
    // ── Step 1: Resolve path parameters ──────────────────────────────
    let resolvedPath = path;
    let usedPlaceholder = false;

    for (const param of parameters.path) {
      log.info("dependency", `Resolving path param {${param.name}}`);

      // Wait for the provider endpoint to finish and cache data
      const basePath = deriveListPath(path);
      if (basePath) {
        const signal = signals.get(basePath);
        if (signal) {
          log.debug("dependency", `Awaiting provider signal for ${basePath}`);
          await signal.promise;
          log.debug("dependency", `Provider signal received for ${basePath}`);
        } else {
          // No registered provider — try fetching the list endpoint directly
          log.warn("dependency", `No registered provider for ${basePath}, fetching directly`);
          const { resolvedEndpoint, connectedAccountId } = resolveEndpoint(basePath, routing);
          const listResult = await executeWithRetry(
            composio, connectedAccountId, resolvedEndpoint, "GET",
            [{ in: "query", name: "maxResults", value: 5 }], undefined, log,
          );
          if (listResult.status >= 200 && listResult.status < 300 && listResult.data) {
            cache.cacheFromResponse(basePath, listResult.data, log);
          }
        }
      }

      // Resolve from cache
      let value = cache.resolve(path, param.name, isDestructive);

      // If cache is empty (e.g., list returned 0 items), wait briefly for
      // other providers that share the same path (e.g., CREATE_EVENT also
      // caches under the same path as LIST_EVENTS).
      if (!value && basePath) {
        const otherProviders = allEndpoints.filter(
          ep => ep.path === basePath && ep.parameters.path.length === 0 && ep.tool_slug !== endpoint.tool_slug,
        );
        if (otherProviders.length > 0) {
          log.debug("dependency", `Cache empty, waiting 2s for other providers to populate...`);
          await sleep(2000);
          value = cache.resolve(path, param.name, isDestructive);
        }
      }

      if (value) {
        resolvedPath = resolvedPath.replace(`{${param.name}}`, value);
        log.info("dependency", `Resolved {${param.name}} = "${value}"`);
      } else {
        // Fallback: use a placeholder — we'll analyze the error response
        // to distinguish "resource not found" from "endpoint not found"
        resolvedPath = resolvedPath.replace(`{${param.name}}`, "placeholder-test-id");
        usedPlaceholder = true;
        log.warn("dependency", `No data for {${param.name}}, using placeholder`);
      }
    }

    // ── Step 2: Resolve routing (account + base URL) ─────────────────
    const { resolvedEndpoint, connectedAccountId } = resolveEndpoint(resolvedPath, routing);
    log.debug("routing", `Resolved endpoint: ${resolvedEndpoint}, account: ${connectedAccountId}`);

    // ── Step 3: Build query parameters ───────────────────────────────
    const queryParams = buildQueryParams(parameters.query);
    log.debug("request", "Query params", queryParams);

    // ── Step 4: Execute the request ──────────────────────────────────
    let finalResult: ApiResponse;
    let finalStatus: EndpointStatus;

    if (parameters.body) {
      // For endpoints with a body: try multiple body variations
      const variations = generateBodyVariations(parameters.body.fields, log);
      const { result, status } = await tryBodyVariations(
        composio, connectedAccountId, resolvedEndpoint, method, queryParams, variations, log,
      );
      finalResult = result;
      finalStatus = status;
    } else {
      // No body needed — single request
      finalResult = await executeWithRetry(
        composio, connectedAccountId, resolvedEndpoint, method, queryParams, undefined, log,
      );
      finalStatus = classify(finalResult);
    }

    // ── Step 5: Cache successful response ────────────────────────────
    if (finalResult.status >= 200 && finalResult.status < 300 && finalResult.data) {
      cache.cacheFromResponse(path, finalResult.data, log);
    }

    // ── Step 6: Handle placeholder ID edge case ──────────────────────
    // A structured 404 with a placeholder = endpoint exists, resource not found
    if (finalStatus === "invalid_endpoint" && usedPlaceholder && isStructuredApiError(finalResult.data)) {
      log.info("classify", "Structured 404 with placeholder ID — endpoint likely exists but could not resolve a real resource ID");
      finalStatus = "error";
    }

    log.info("result", `Classification: ${finalStatus} (HTTP ${finalResult.status})`);
    return makeReport(endpoint, finalStatus, finalResult);

  } catch (err: any) {
    log.error("fatal", `Unhandled exception: ${err.message}`, { stack: err.stack });
    return makeReport(endpoint, "error", { status: 0, error: err.message, isProxyError: true });
  } finally {
    // Always signal completion so dependent endpoints don't hang forever
    const signal = signals.get(path);
    if (signal) signal.resolve();
  }
}

// ─── Body Variation Strategy ──────────────────────────────────────────────

/**
 * Try multiple body variations for POST/PUT/PATCH endpoints.
 * Stops on the first 2xx or a clear non-retriable classification.
 */
async function tryBodyVariations(
  composio: Composio,
  connectedAccountId: string,
  resolvedEndpoint: string,
  method: string,
  queryParams: { in: string; name: string; value: unknown }[],
  variations: { label: string; body: Record<string, unknown> }[],
  log: EndpointLogger,
): Promise<{ result: ApiResponse; status: EndpointStatus }> {
  let lastResult: ApiResponse = { status: 0, error: "No variations attempted" };
  let lastStatus: EndpointStatus = "error";

  for (const variation of variations) {
    log.info("body-try", `Trying body variation: ${variation.label}`, variation.body);

    const result = await executeWithRetry(
      composio, connectedAccountId, resolvedEndpoint, method, queryParams, variation.body, log,
    );
    const status = classify(result);

    // Success — stop immediately
    if (status === "valid") {
      log.info("body-try", `Variation "${variation.label}" succeeded with HTTP ${result.status}`);
      return { result, status };
    }

    // Clear non-retriable classification — stop
    if (status === "invalid_endpoint" || status === "insufficient_scopes") {
      log.info("body-try", `Variation "${variation.label}" got definitive classification: ${status}`);
      return { result, status };
    }

    // Client error (400/422) — might be our body's fault, try next variation
    if (isClientError(result)) {
      log.warn("body-try", `Variation "${variation.label}" got HTTP ${result.status}, trying next`);
      lastResult = result;
      lastStatus = status;
      continue;
    }

    // Other error — stop trying
    lastResult = result;
    lastStatus = status;
    break;
  }

  log.warn("body-try", `All body variations exhausted, best result: HTTP ${lastResult.status}`);
  return { result: lastResult, status: lastStatus };
}

// ─── API Execution with Retry + Backoff ───────────────────────────────────

async function executeWithRetry(
  composio: Composio,
  connectedAccountId: string,
  endpoint: string,
  method: string,
  parameters?: { in: string; name: string; value: unknown }[],
  body?: unknown,
  log?: EndpointLogger,
): Promise<ApiResponse> {
  let lastResult: ApiResponse = { status: 0, error: "No attempts made" };

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const startTime = Date.now();
    lastResult = await executeProxy(composio, connectedAccountId, endpoint, method, parameters, body);
    const duration = Date.now() - startTime;

    log?.trace("request", `Attempt ${attempt}/${MAX_RETRIES}: ${method} ${endpoint} → HTTP ${lastResult.status}`, {
      status: lastResult.status,
      isProxyError: lastResult.isProxyError,
      hasData: !!lastResult.data,
      bodyPreview: lastResult.data ? JSON.stringify(lastResult.data).substring(0, 200) : null,
    }, duration);

    if (!isRetriable(lastResult)) return lastResult;

    if (attempt < MAX_RETRIES) {
      const delay = BACKOFF_BASE_MS * Math.pow(2, attempt - 1);
      log?.warn("retry", `Retriable error (HTTP ${lastResult.status}), backing off ${delay}ms`);
      await sleep(delay);
    }
  }

  log?.error("retry", `Exhausted ${MAX_RETRIES} retries, last status: ${lastResult.status}`);
  return lastResult;
}

// ─── Raw Proxy Execution ──────────────────────────────────────────────────

async function executeProxy(
  composio: Composio,
  connectedAccountId: string,
  endpoint: string,
  method: string,
  parameters?: { in: string; name: string; value: unknown }[],
  body?: unknown,
): Promise<ApiResponse> {
  try {
    const opts: any = {
      endpoint,
      method: method as "GET" | "POST" | "PUT" | "DELETE" | "PATCH",
      connectedAccountId,
    };
    if (parameters && parameters.length > 0) opts.parameters = parameters;
    if (body !== undefined) opts.body = body;

    const result = await withTimeout(
      composio.tools.proxyExecute(opts),
      REQUEST_TIMEOUT_MS,
    );

    // Detect HTML error pages — these come from the API server itself
    // (not Composio proxy) when the endpoint path doesn't exist.
    // Treat as a normal API response with the returned status code.
    const isHtmlResponse = typeof result?.data === "string" &&
      result.data.includes("<!DOCTYPE");

    return {
      status: result?.status ?? 0,
      data: isHtmlResponse ? null : result?.data,
      error: isHtmlResponse ? "API returned HTML error page — endpoint path not found" : undefined,
      isProxyError: false,
    };
  } catch (err: any) {
    const msg = err.message || String(err);

    // Proxy/network errors
    if (msg.includes("timeout") || msg.includes("ECONNREFUSED") || msg.includes("ENOTFOUND") ||
        msg.includes("socket") || msg.includes("network") || msg.includes("fetch failed") ||
        msg.includes("Connected account not found") || msg.includes("ConnectedAccount")) {
      return { status: 0, error: `Proxy error: ${msg}`, isProxyError: true };
    }

    // SDK errors that embed HTTP status codes (e.g., "404 {...}")
    const statusMatch = msg.match(/^(\d{3})\s/);
    if (statusMatch) {
      const code = parseInt(statusMatch[1]);
      // Try to extract JSON data from the error message
      let data: unknown = null;
      try {
        const jsonStart = msg.indexOf("{");
        if (jsonStart > -1) data = JSON.parse(msg.substring(jsonStart));
      } catch {}
      return { status: code, data, error: msg, isProxyError: false };
    }

    return { status: 0, error: `Proxy exception: ${msg}`, isProxyError: true };
  }
}

// ─── Report Builder ───────────────────────────────────────────────────────

function makeReport(
  endpoint: EndpointDefinition,
  status: EndpointStatus,
  result: ApiResponse,
): EndpointReport {
  return {
    tool_slug: endpoint.tool_slug,
    method: endpoint.method,
    path: endpoint.path,
    status,
    http_status_code: result.status || null,
    response_summary: buildResponseSummary(
      endpoint.method, endpoint.path, status, result.status || null, result, endpoint.required_scopes,
    ),
    response_body: sanitizeResponse(result.data ?? result.error ?? null),
    required_scopes: endpoint.required_scopes,
    available_scopes: [], // populated after all agents complete
  };
}

// ─── Utilities ────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Request timeout after ${ms}ms`)), ms);
    promise.then(
      val => { clearTimeout(timer); resolve(val); },
      err => { clearTimeout(timer); reject(err); },
    );
  });
}
