import { Composio } from "@composio/core";
import type { EndpointDefinition } from "./types";
import { createEndpointLogger } from "./logger";

/**
 * Routing discovery: auto-detect which connected account and URL format
 * to use for each endpoint path prefix.
 *
 * This handles two real-world issues with Composio's proxyExecute:
 *   1. Connected accounts are per-toolkit — Gmail endpoints need the Gmail account,
 *      Calendar endpoints need the Calendar account, etc.
 *   2. Some toolkits require full URLs (e.g., https://www.googleapis.com/calendar/...)
 *      while others work with relative paths (e.g., /gmail/v1/...).
 *
 * The discovery is fully generic — it probes each connected account with a test
 * endpoint to find the working combination, then caches it per path prefix.
 */

export interface RoutingConfig {
  connectedAccountId: string;
  baseUrl: string; // '' for relative paths, or 'https://...' to prepend
}

/**
 * Discover routing configuration for all endpoint path prefixes.
 * Returns a map: pathPrefix → { connectedAccountId, baseUrl }
 */
export async function discoverRouting(
  composio: Composio,
  endpoints: EndpointDefinition[],
): Promise<Map<string, RoutingConfig>> {
  const log = createEndpointLogger("ROUTING");
  const routing = new Map<string, RoutingConfig>();

  // List all connected accounts
  log.info("discovery", "Listing connected accounts...");
  const accountsResponse = await composio.connectedAccounts.list({ limit: 50 });
  const accounts = accountsResponse.items.filter(a => a.status === "ACTIVE");
  log.info("discovery", `Found ${accounts.length} active connected accounts`, {
    accounts: accounts.map(a => ({ id: a.id, toolkit: a.toolkit?.slug })),
  });

  if (accounts.length === 0) {
    log.error("discovery", "No active connected accounts found! Run setup.sh first.");
    return routing;
  }

  // Get unique path prefixes (first 2 path segments)
  const prefixes = [...new Set(endpoints.map(ep => getPathPrefix(ep.path)))];
  log.info("discovery", `Probing ${prefixes.length} unique path prefixes`, { prefixes });

  // For each prefix, find a simple GET endpoint to use as a probe
  for (const prefix of prefixes) {
    const probe = endpoints.find(
      ep => ep.path.startsWith(prefix) && ep.method === "GET" && ep.parameters.path.length === 0,
    );
    if (!probe) {
      log.warn("discovery", `No simple GET endpoint found for prefix ${prefix}, skipping probe`);
      continue;
    }

    log.info("discovery", `Probing prefix "${prefix}" with ${probe.method} ${probe.path}`);

    let found = false;
    for (const account of accounts) {
      // Strategy 1: Try relative path
      const r1 = await probeEndpoint(composio, probe.path, account.id);
      if (r1 === "ok") {
        routing.set(prefix, { connectedAccountId: account.id, baseUrl: "" });
        log.info("discovery", `✓ ${prefix} → account ${account.id} (${account.toolkit?.slug}), relative path`);
        found = true;
        break;
      }

      if (r1 === "routing_issue") {
        // Strategy 2: Try common full URL base patterns
        const bases = guessBaseUrls(prefix);
        for (const base of bases) {
          const r2 = await probeEndpoint(composio, base + probe.path, account.id);
          if (r2 === "ok") {
            routing.set(prefix, { connectedAccountId: account.id, baseUrl: base });
            log.info("discovery", `✓ ${prefix} → account ${account.id} (${account.toolkit?.slug}), base: ${base}`);
            found = true;
            break;
          }
        }
        if (found) break;
      }

      // Strategy 3: "wrong account" (403/401) means the endpoint exists but this account can't access it
      // Keep trying other accounts
      if (r1 === "wrong_account") {
        log.debug("discovery", `Account ${account.id} (${account.toolkit?.slug}) got auth error for ${prefix}`);
      }
    }

    if (!found) {
      // Fallback: use the first account with relative path
      log.warn("discovery", `Could not find working account for prefix ${prefix}, using first account as fallback`);
      routing.set(prefix, { connectedAccountId: accounts[0].id, baseUrl: "" });
    }
  }

  return routing;
}

/**
 * Resolve the full endpoint URL and account for a given endpoint.
 */
export function resolveEndpoint(
  path: string,
  routing: Map<string, RoutingConfig>,
): { resolvedEndpoint: string; connectedAccountId: string } {
  const prefix = getPathPrefix(path);
  const config = routing.get(prefix);

  if (config) {
    return {
      resolvedEndpoint: config.baseUrl + path,
      connectedAccountId: config.connectedAccountId,
    };
  }

  // No routing found — use path as-is with empty account (will likely fail)
  return { resolvedEndpoint: path, connectedAccountId: "" };
}

// ─── Helpers ──────────────────────────────────────────────────────────────

/** Extract first 2 path segments as a prefix: /gmail/v1/... → /gmail/v1 */
function getPathPrefix(path: string): string {
  const segments = path.split("/").filter(Boolean);
  return "/" + segments.slice(0, 2).join("/");
}

type ProbeResult = "ok" | "routing_issue" | "wrong_account" | "not_found" | "error";

async function probeEndpoint(
  composio: Composio,
  endpoint: string,
  accountId: string,
): Promise<ProbeResult> {
  try {
    const result = await composio.tools.proxyExecute({
      endpoint,
      method: "GET",
      connectedAccountId: accountId,
    });

    if (result?.status >= 200 && result?.status < 300) return "ok";
    if (result?.status === 403 || result?.status === 401) return "wrong_account";
    if (result?.status === 404) {
      // Check if it's an HTML 404 (routing issue) vs JSON 404 (endpoint not found)
      if (typeof result?.data === "string" && result.data.includes("<!DOCTYPE")) {
        return "routing_issue";
      }
      return "not_found";
    }
    // Any other response means the proxy routed successfully (even if the API returned an error)
    return "ok";
  } catch (e: any) {
    const msg = e.message || "";
    if (msg.includes("Connected account not found") || msg.includes("ConnectedAccount")) {
      return "wrong_account";
    }
    return "error";
  }
}

/**
 * Guess possible base URLs from a path prefix.
 * Uses common API hosting patterns (Google, etc.).
 */
function guessBaseUrls(prefix: string): string[] {
  const bases: string[] = [];
  const firstSegment = prefix.split("/").filter(Boolean)[0];

  // Common Google pattern: {service}.googleapis.com
  if (firstSegment) {
    bases.push(`https://${firstSegment}.googleapis.com`);
  }

  // Fallback: www.googleapis.com (works for Calendar, many other Google APIs)
  bases.push("https://www.googleapis.com");

  // Generic fallbacks for non-Google APIs
  bases.push("https://api.example.com");

  return [...new Set(bases)];
}
