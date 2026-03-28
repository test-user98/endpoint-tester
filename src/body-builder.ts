import type { ParameterDef } from "./types";
import type { EndpointLogger } from "./logger";

/**
 * Generic request body constructor.
 *
 * Builds request bodies from parameter definitions using a recursive strategy:
 * generates multiple body variations (full → minimal → empty) so the caller
 * can try them in order until one succeeds.
 *
 * This is fully generic — it reads field types and descriptions to infer
 * values. It does NOT hardcode any app-specific knowledge.
 */

/** A single body variation to try */
export interface BodyVariation {
  label: string;
  body: Record<string, unknown>;
}

/**
 * Generate an ordered list of body variations to try, from most complete to least.
 * The caller should try each in order and stop on the first success.
 */
export function generateBodyVariations(
  fields: ParameterDef[],
  log?: EndpointLogger,
): BodyVariation[] {
  const variations: BodyVariation[] = [];
  const requiredFields = fields.filter(f => f.required);
  const optionalFields = fields.filter(f => !f.required);

  // Variation 1: All required fields with best-effort values
  const fullBody: Record<string, unknown> = {};
  for (const field of requiredFields) {
    fullBody[field.name] = generateFieldValue(field);
  }
  variations.push({ label: "full-required", body: fullBody });

  // Variation 2: Required fields with simplified values (simpler object structures)
  if (requiredFields.some(f => f.type === "object")) {
    const simplified: Record<string, unknown> = {};
    for (const field of requiredFields) {
      simplified[field.name] = generateFieldValue(field, true);
    }
    variations.push({ label: "simplified", body: simplified });
  }

  // Variation 3: Required + optional fields (some APIs need optional fields to work)
  if (optionalFields.length > 0) {
    const withOptional: Record<string, unknown> = { ...fullBody };
    for (const field of optionalFields) {
      withOptional[field.name] = generateFieldValue(field);
    }
    variations.push({ label: "full-with-optional", body: withOptional });
  }

  // Variation 4: Empty object (some endpoints accept empty POST)
  variations.push({ label: "empty", body: {} });

  log?.debug("body-builder", `Generated ${variations.length} body variations`, {
    labels: variations.map(v => v.label),
  });

  return variations;
}

/**
 * Build query parameters from definitions.
 * Includes all required params + maxResults (if available) for list endpoints.
 */
export function buildQueryParams(
  defs: ParameterDef[],
): { in: string; name: string; value: unknown }[] {
  const params: { in: string; name: string; value: unknown }[] = [];

  for (const def of defs) {
    if (def.required) {
      params.push({ in: "query", name: def.name, value: generateFieldValue(def) });
    }
  }

  // Add maxResults if available — limits response size and speeds up list calls
  if (defs.some(d => d.name === "maxResults" && !d.required)) {
    if (!params.some(p => p.name === "maxResults")) {
      params.push({ in: "query", name: "maxResults", value: 5 });
    }
  }

  return params;
}

// ─── Field Value Generation ───────────────────────────────────────────────

/**
 * Generate a value for a single field based on its type and description.
 * Uses description hints (RFC 2822, RFC3339, base64, etc.) to produce valid data.
 */
function generateFieldValue(field: ParameterDef, simplified: boolean = false): unknown {
  const desc = field.description.toLowerCase();

  switch (field.type) {
    case "string":
      return generateStringValue(field.name, desc);

    case "integer":
    case "number":
      return generateNumericValue(desc);

    case "boolean":
      return true;

    case "object":
      return simplified
        ? { value: "test" }
        : buildObjectFromDescription(field.name, field.description);

    case "array":
      return [];

    default:
      return `test-${field.name}`;
  }
}

function generateStringValue(name: string, desc: string): string {
  // Base64-encoded email (RFC 2822)
  if (desc.includes("base64") && (desc.includes("rfc 2822") || desc.includes("rfc2822") || desc.includes("email message"))) {
    return createBase64Email();
  }

  // DateTime (RFC3339 / ISO 8601)
  if (desc.includes("rfc3339") || desc.includes("rfc 3339") || desc.includes("iso 8601") || desc.includes("iso8601")) {
    return new Date(Date.now() + 3_600_000).toISOString();
  }

  // URL/URI fields
  if (desc.includes("url") || desc.includes("uri") || desc.includes("link")) {
    return "https://example.com/test";
  }

  // Email fields
  if (desc.includes("email address") || name.toLowerCase().includes("email")) {
    return "agent-test@example.com";
  }

  // Enum-like fields — check for "acceptable values" pattern
  const enumMatch = desc.match(/acceptable values are\s+(.+)/i);
  if (enumMatch) {
    // Pick the first acceptable value
    const valMatch = enumMatch[1].match(/'(\w+)'/);
    if (valMatch) return valMatch[1];
  }

  return `test-${name}`;
}

function generateNumericValue(desc: string): number {
  if (desc.includes("maximum") || desc.includes("limit") || desc.includes("max")) {
    return 5;
  }
  if (desc.includes("page") || desc.includes("offset")) {
    return 1;
  }
  return 1;
}

/**
 * Parse an object field's description to extract expected sub-fields.
 *
 * Looks for patterns like:
 *   "Must include 'dateTime' (RFC3339) and 'timeZone'"
 *   "Must include 'raw' field with base64url encoded..."
 *
 * Uses the outer field name to disambiguate (e.g., "start" vs "end" time offsets).
 */
function buildObjectFromDescription(fieldName: string, description: string): Record<string, unknown> {
  const obj: Record<string, unknown> = {};
  const desc = description.toLowerCase();
  const isStart = fieldName.toLowerCase().includes("start");
  const isEnd = fieldName.toLowerCase().includes("end");

  // Extract sub-field names from 'quoted' references in the description
  const quotedMatches = description.match(/'(\w+)'/g);
  if (quotedMatches) {
    for (const match of quotedMatches) {
      const subField = match.replace(/'/g, "");

      if (subField === "dateTime" || subField.toLowerCase() === "datetime") {
        const hourOffset = isEnd ? 2 : 1;
        obj[subField] = new Date(Date.now() + hourOffset * 3_600_000).toISOString();
      } else if (subField === "timeZone" || subField.toLowerCase() === "timezone") {
        obj[subField] = "UTC";
      } else if (subField === "raw") {
        obj[subField] = createBase64Email();
      } else if (subField.toLowerCase().includes("date") || subField.toLowerCase().includes("time")) {
        const hourOffset = isEnd ? 2 : 1;
        obj[subField] = new Date(Date.now() + hourOffset * 3_600_000).toISOString();
      } else {
        obj[subField] = `test-${subField}`;
      }
    }
  }

  // Fallback: if no quoted fields found, infer from description keywords
  if (Object.keys(obj).length === 0) {
    if (desc.includes("time") || desc.includes("date")) {
      const hourOffset = isEnd ? 2 : 1;
      obj.dateTime = new Date(Date.now() + hourOffset * 3_600_000).toISOString();
      obj.timeZone = "UTC";
    } else {
      obj.value = "test";
    }
  }

  return obj;
}

/**
 * Create a minimal valid RFC 2822 email, base64url-encoded.
 * Used for Gmail-like APIs that accept raw email messages.
 */
function createBase64Email(): string {
  const msg = [
    "From: agent-test@example.com",
    "To: agent-test@example.com",
    "Subject: Endpoint Validation Test",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Automated test from endpoint validation agent.",
  ].join("\r\n");

  // base64url encoding: standard base64 with +→- /→_ and no padding
  const base64 = btoa(msg);
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
