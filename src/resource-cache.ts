import type { EndpointDefinition } from "./types";
import type { EndpointLogger } from "./logger";

/**
 * Shared resource cache for dependency resolution across endpoint agents.
 *
 * When a list endpoint (e.g., GET /messages) returns data, extracted resource
 * IDs are cached here. Detail endpoints (e.g., GET /messages/{messageId})
 * query this cache to resolve their path parameters.
 *
 * This is fully generic — it does not know about Gmail, Calendar, or any
 * specific API. It works by:
 *   1. Normalizing paths to derive "base resource paths"
 *   2. Extracting objects with ID-like fields from any response shape
 *   3. Matching path param names to cached resource fields
 */

export type CachedResource = Record<string, unknown>;

export class ResourceCache {
  /** path → array of resource objects */
  private store = new Map<string, CachedResource[]>();

  /** Track which resource indices have been used per path (for non-conflicting resolution) */
  private usedIndices = new Map<string, Set<number>>();

  /**
   * Cache resources extracted from an API response.
   * Handles common response shapes: { items: [...] }, { messages: [...] }, [...], { id: "..." }
   */
  cacheFromResponse(path: string, data: unknown, log?: EndpointLogger): void {
    if (!data || typeof data !== "object") return;

    let items: CachedResource[] = [];

    if (Array.isArray(data)) {
      // Direct array response
      items = data.filter(isObject);
    } else {
      // Find the best array field: prefer arrays whose items have "id" fields.
      // This avoids caching metadata arrays (e.g., "defaultReminders") over
      // actual resource arrays (e.g., "items", "messages", "events").
      const obj = data as Record<string, unknown>;
      let bestKey: string | null = null;
      let bestItems: CachedResource[] = [];
      let bestScore = -1;

      for (const key of Object.keys(obj)) {
        const val = obj[key];
        if (!Array.isArray(val) || val.length === 0 || !isObject(val[0])) continue;

        const candidate = val.filter(isObject);
        let score = 0;

        // Score: items with "id" field are most likely resource arrays
        if (candidate.some(c => c.id != null)) score += 10;
        // Score: standard list response keys get a boost
        if (["items", "messages", "events", "threads", "labels", "calendars", "results", "data"].includes(key)) score += 5;
        // Score: longer arrays are more likely to be the primary list
        score += Math.min(candidate.length, 5);

        if (score > bestScore) {
          bestScore = score;
          bestKey = key;
          bestItems = candidate;
        }
      }

      if (bestKey) {
        items = bestItems;
        log?.debug("cache", `Found ${items.length} resources under field "${bestKey}" (score: ${bestScore})`);
      }
      // If the response itself is a single resource with an id
      if (items.length === 0 && (data as any).id) {
        items = [data as CachedResource];
        log?.debug("cache", "Cached single resource from response");
      }
    }

    if (items.length > 0) {
      const existing = this.store.get(path) || [];
      this.store.set(path, [...existing, ...items.slice(0, 20)]);
      log?.debug("cache", `Cached ${items.length} resources for path: ${path} (total: ${existing.length + items.length})`);
    }
  }

  /**
   * Resolve a path parameter value from cached resources.
   *
   * Strategy:
   *   1. Derive the base "list path" from the full path (e.g., /messages/{id}/trash → /messages)
   *   2. Search cached resources for a field matching the param name, or fallback to "id"
   *   3. For destructive operations, prefer using a different resource than read operations
   */
  resolve(fullPath: string, paramName: string, preferUnused: boolean = false): string | null {
    const basePath = deriveListPath(fullPath);
    if (!basePath) return null;

    for (const [cachedPath, resources] of this.store) {
      const cachedBase = deriveListPath(cachedPath) || cachedPath;
      if (cachedBase !== basePath && cachedPath !== basePath) continue;

      if (resources.length === 0) continue;

      // Pick an index — prefer unused ones for destructive operations
      const usedSet = this.usedIndices.get(`${basePath}:${paramName}`) || new Set();
      let idx = 0;

      if (preferUnused) {
        for (let i = resources.length - 1; i >= 0; i--) {
          if (!usedSet.has(i)) { idx = i; break; }
        }
      }

      const resource = resources[idx];

      // Track usage
      usedSet.add(idx);
      this.usedIndices.set(`${basePath}:${paramName}`, usedSet);

      // Try exact param name match first (e.g., messageId → resource.messageId)
      if (resource[paramName] != null) return String(resource[paramName]);
      // Fallback to common ID fields
      if (resource["id"] != null) return String(resource["id"]);
      if (resource["uid"] != null) return String(resource["uid"]);
      if (resource["uuid"] != null) return String(resource["uuid"]);
      if (resource["key"] != null) return String(resource["key"]);
      if (resource["slug"] != null) return String(resource["slug"]);
    }

    return null;
  }

  /** Check if any resources exist for a given base path */
  hasResources(fullPath: string): boolean {
    const basePath = deriveListPath(fullPath) || fullPath;
    for (const [cachedPath, resources] of this.store) {
      const cachedBase = deriveListPath(cachedPath) || cachedPath;
      if ((cachedBase === basePath || cachedPath === basePath) && resources.length > 0) {
        return true;
      }
    }
    return false;
  }
}

/**
 * Derive the "list" path from a detail/action path by stripping everything
 * from the first path parameter onward.
 *
 * Examples:
 *   /gmail/v1/users/me/messages/{messageId}        → /gmail/v1/users/me/messages
 *   /gmail/v1/users/me/messages/{messageId}/trash   → /gmail/v1/users/me/messages
 *   /calendar/v3/calendars/primary/events/{eventId} → /calendar/v3/calendars/primary/events
 *   /repos/{owner}/{repo}/issues                    → /repos
 */
export function deriveListPath(path: string): string | null {
  const idx = path.indexOf("{");
  if (idx === -1) return null;
  return path.substring(0, idx).replace(/\/$/, "") || null;
}

/**
 * Find the best provider endpoint for a given dependent endpoint's path.
 * Prefers GET endpoints with no path params (list endpoints).
 */
export function findProviderEndpoint(
  dependentPath: string,
  allEndpoints: EndpointDefinition[],
): EndpointDefinition | null {
  const basePath = deriveListPath(dependentPath);
  if (!basePath) return null;

  // Best: GET endpoint at the exact base path with no path params
  const getProvider = allEndpoints.find(
    ep => ep.path === basePath && ep.method === "GET" && ep.parameters.path.length === 0,
  );
  if (getProvider) return getProvider;

  // Fallback: any endpoint at the base path with no path params (e.g., POST that creates resources)
  return allEndpoints.find(
    ep => ep.path === basePath && ep.parameters.path.length === 0,
  ) || null;
}

function isObject(val: unknown): val is Record<string, unknown> {
  return typeof val === "object" && val !== null && !Array.isArray(val);
}
