import type { JsonRecord, ValidationResult } from "../types.js";
import { isStrictIsoTimestamp, normalizeSource } from "../domain/profile.js";

export interface MutationEnvelope {
  schema_version: number;
  request_id: string;
  source: string;
  occurred_at: string;
  dry_run: boolean;
  input: JsonRecord;
}

export function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function apiError(code: string, message: string, details?: unknown): JsonRecord {
  var error: JsonRecord = { code: code, message: message };
  if (details !== undefined) error.details = details;
  return { ok: false, error: error };
}

export function apiSuccess(data: JsonRecord): JsonRecord {
  return { ok: true, data: data };
}

export function validateMutationEnvelope(input: unknown): ValidationResult<MutationEnvelope> {
  if (!isJsonRecord(input)) {
    return { ok: false, code: "INVALID_BODY", message: "JSON object body is required" };
  }
  if (input.schema_version !== 1) {
    return { ok: false, code: "UNSUPPORTED_SCHEMA_VERSION", message: "schema_version must be 1" };
  }
  if (typeof input.request_id !== "string") {
    return { ok: false, code: "INVALID_REQUEST_ID", message: "request_id is required" };
  }
  var requestId = input.request_id.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(requestId)) {
    return { ok: false, code: "INVALID_REQUEST_ID", message: "request_id must be a stable 8 to 128 character identifier" };
  }
  var sourceResult = normalizeSource(input.source);
  if (!sourceResult.ok || !sourceResult.value) {
    return { ok: false, code: sourceResult.code, message: sourceResult.message };
  }
  if (!isStrictIsoTimestamp(input.occurred_at)) {
    return { ok: false, code: "INVALID_OCCURRED_AT", message: "occurred_at must be an ISO timestamp" };
  }
  if (Date.parse(input.occurred_at) > Date.now() + 5 * 60 * 1000) {
    return { ok: false, code: "INVALID_OCCURRED_AT", message: "occurred_at cannot be more than five minutes in the future" };
  }
  return {
    ok: true,
    value: {
      schema_version: 1,
      request_id: requestId,
      source: sourceResult.value,
      occurred_at: input.occurred_at,
      dry_run: input.dry_run === true,
      input: input
    }
  };
}

export function validationError(result: ValidationResult<unknown>): JsonRecord {
  return apiError(result.code || "VALIDATION_ERROR", result.message || "Validation failed");
}

export function requireMethod(actual: string, expected: string): JsonRecord | null {
  if (actual.toUpperCase() === expected) return null;
  return apiError("METHOD_NOT_ALLOWED", "This route requires " + expected);
}
