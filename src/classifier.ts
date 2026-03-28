import type { EndpointStatus } from "./types";

/**
 * Response classification logic.
 *
 * Distinguishes between:
 *   - Valid endpoints (2xx)
 *   - Invalid/fake endpoints (404, 405)
 *   - Insufficient scopes (401, 403)
 *   - Proxy errors (connection failures, SDK exceptions)
 *   - Transient errors (429, 5xx — retriable)
 *   - Client errors (400 — might be our fault)
 */

export interface ApiResponse {
  status: number;
  data?: any;
  error?: string;
  /** True if the error came from the Composio proxy/SDK, not the target API */
  isProxyError?: boolean;
}

// ─── Classification ───────────────────────────────────────────────────────

export function classify(result: ApiResponse): EndpointStatus {
  const { status, data, error, isProxyError } = result;

  // Proxy errors are infrastructure issues, not endpoint issues
  if (isProxyError) return "error";

  // 2xx = endpoint is valid and callable
  if (status >= 200 && status < 300) return "valid";

  // 404 / 405 = endpoint doesn't exist (but check for structured API errors)
  if (status === 404 || status === 405) {
    // A structured API error on 404 means the endpoint exists but the resource wasn't found.
    // This happens when we used a placeholder ID. The endpoint itself is real.
    if (status === 404 && isStructuredApiError(data)) {
      // We'll let the caller handle this case — return "invalid_endpoint" and
      // the endpoint agent will override if it used a placeholder ID.
      return "invalid_endpoint";
    }
    return "invalid_endpoint";
  }

  // 401 / 403 = auth or scope issue
  if (status === 401 || status === 403) return "insufficient_scopes";

  // Check response body for permission-related error messages
  if (data && typeof data === "object") {
    const bodyStr = JSON.stringify(data).toLowerCase();
    if (bodyStr.includes("insufficient") || bodyStr.includes("forbidden") ||
        bodyStr.includes("permission denied") || bodyStr.includes("access denied") ||
        bodyStr.includes("not authorized")) {
      return "insufficient_scopes";
    }
    // Some APIs return 400 with "not found" style messages for invalid endpoints
    if (bodyStr.includes("method not allowed") || bodyStr.includes("not implemented")) {
      return "invalid_endpoint";
    }
  }

  // Everything else (400, 5xx, 0, etc.) = error
  return "error";
}

// ─── Retriability ─────────────────────────────────────────────────────────

/** Check if a response indicates a transient error that should be retried */
export function isRetriable(result: ApiResponse): boolean {
  // Rate limited
  if (result.status === 429) return true;
  // Server errors (might be transient)
  if (result.status >= 500 && result.status < 600) return true;
  // Proxy/network errors (timeout, connection refused, etc.)
  if (result.isProxyError) return true;
  return false;
}

/** Check if a response is a client error that might be fixed with different params */
export function isClientError(result: ApiResponse): boolean {
  return result.status === 400 || result.status === 422;
}

// ─── Structured API Error Detection ───────────────────────────────────────

/**
 * Detect whether a 404 response is a structured API error (meaning the endpoint
 * exists but the specific resource wasn't found) vs a generic 404 (endpoint doesn't exist).
 *
 * Structured API errors have JSON bodies with error codes/messages.
 * Generic 404s are HTML pages or empty responses.
 *
 * Examples of structured errors:
 *   Google: { error: { code: 404, message: "Not found", status: "NOT_FOUND" } }
 *   Stripe: { error: { type: "invalid_request_error", message: "..." } }
 *   Generic: { code: 404, message: "Not found" }
 */
export function isStructuredApiError(data: unknown): boolean {
  if (!data || typeof data !== "object") return false;
  const d = data as any;

  // Google-style: { error: { code, message } }
  if (d.error && typeof d.error === "object" && (d.error.code || d.error.status || d.error.type)) {
    return true;
  }
  // Generic: { code: ..., message: ... }
  if (typeof d.code === "number" && typeof d.message === "string") return true;
  // { status: ..., message: ... }
  if (typeof d.status === "number" && typeof d.message === "string") return true;
  // { statusCode: ..., message: ... }
  if (typeof d.statusCode === "number" && typeof d.message === "string") return true;

  return false;
}

// ─── Response Sanitization ────────────────────────────────────────────────

/**
 * Sanitize response data for the report:
 *   - Redact email addresses and other PII
 *   - Truncate large responses
 */
export function sanitizeResponse(data: unknown): unknown {
  if (data == null) return null;
  try {
    let json = JSON.stringify(data);

    // Redact email addresses
    json = json.replace(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g, "[REDACTED_EMAIL]");

    // Redact phone numbers (basic pattern)
    json = json.replace(/\+?[0-9]{10,15}/g, "[REDACTED_PHONE]");

    // Truncate if too large
    if (json.length > 3000) {
      return {
        _truncated: true,
        _original_bytes: json.length,
        _preview: json.substring(0, 1500) + "...",
      };
    }

    return JSON.parse(json);
  } catch {
    return data;
  }
}

// ─── Summary Builder ──────────────────────────────────────────────────────

export function buildResponseSummary(
  method: string,
  path: string,
  status: EndpointStatus,
  httpStatus: number | null,
  result: ApiResponse,
  requiredScopes: string[],
): string {
  const prefix = `${method} ${path}`;

  switch (status) {
    case "valid":
      return `${prefix} returned HTTP ${httpStatus} — endpoint exists and is callable. Response contains valid data.`;

    case "invalid_endpoint":
      if (result.isProxyError) {
        return `${prefix} — proxy could not route to this endpoint, likely does not exist.`;
      }
      return `${prefix} returned HTTP ${httpStatus} — endpoint does not exist in the target API. ` +
        (httpStatus === 405 ? "The HTTP method is not allowed for this path." : "Path not found.");

    case "insufficient_scopes":
      return `${prefix} returned HTTP ${httpStatus} — account lacks required permissions. ` +
        `Required scopes: [${requiredScopes.join(", ")}]. ` +
        `The endpoint exists but the connected account is not authorized.`;

    case "error":
      if (result.isProxyError) {
        return `${prefix} — proxy/infrastructure error: ${result.error || "unknown"}. ` +
          `This is NOT an API error — the Composio proxy failed to reach the target.`;
      }
      return `${prefix} returned HTTP ${httpStatus} — ${result.error || "request could not be completed successfully"}. ` +
        `The endpoint may exist but could not be called with a valid request.`;
  }
}
