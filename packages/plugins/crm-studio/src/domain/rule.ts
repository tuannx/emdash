import type { CrmProfile, CrmSegment, JsonRecord, ValidationResult } from "../types.js";
import { isKnownTrait, normalizeOptionalText, stableStringify } from "./profile.js";

type TruthValue = true | false | "unknown";

var LOGICAL_OPERATORS: Record<string, boolean> = { and: true, or: true, not: true };
var LEAF_OPERATORS: Record<string, boolean> = {
  eq: true,
  not_eq: true,
  in: true,
  not_in: true,
  gte: true,
  lte: true,
  gt: true,
  lt: true,
  present: true,
  blank: true
};
var DATE_TRAITS: Record<string, boolean> = {
  last_active_at: true,
  last_premium_conversion_at: true,
  user_created_at: true
};

interface RuleBudget {
  nodes: number;
}

function failure<T>(result: ValidationResult<unknown>): ValidationResult<T> {
  return { ok: false, code: result.code, message: result.message };
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneJson(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    var outputArray: unknown[] = [];
    for (var arrayIndex = 0; arrayIndex < value.length; arrayIndex++) {
      outputArray.push(cloneJson(value[arrayIndex]));
    }
    return outputArray;
  }
  var inputRecord = value as JsonRecord;
  var outputRecord: JsonRecord = {};
  var keys = Object.keys(inputRecord);
  for (var index = 0; index < keys.length; index++) {
    outputRecord[keys[index]] = cloneJson(inputRecord[keys[index]]);
  }
  return outputRecord;
}

function validateLeafValue(operator: string, value: unknown): boolean {
  if (operator === "present" || operator === "blank") return value === undefined;
  if (operator === "in" || operator === "not_in") {
    if (!Array.isArray(value) || value.length === 0 || value.length > 100) return false;
    for (var index = 0; index < value.length; index++) {
      if (!validateScalar(value[index])) return false;
    }
    return true;
  }
  return validateScalar(value);
}

function validateScalar(value: unknown): boolean {
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  return typeof value === "string" && value.length <= 200;
}

function validateRuleNode(input: unknown, depth: number, budget: RuleBudget): ValidationResult<JsonRecord> {
  if (!isRecord(input)) return { ok: false, code: "INVALID_RULE", message: "Rule node must be an object" };
  if (depth > 8) return { ok: false, code: "RULE_TOO_DEEP", message: "Rule depth cannot exceed 8" };
  budget.nodes++;
  if (budget.nodes > 100) return { ok: false, code: "RULE_TOO_LARGE", message: "Rule cannot exceed 100 nodes" };

  if (typeof input.op === "string") {
    var logicalOperator = input.op;
    if (!LOGICAL_OPERATORS[logicalOperator]) {
      return { ok: false, code: "INVALID_RULE_OPERATOR", message: "Unsupported logical operator" };
    }
    if (!Array.isArray(input.rules)) {
      return { ok: false, code: "INVALID_RULE", message: "Logical rule requires a rules array" };
    }
    if (logicalOperator === "not" && input.rules.length !== 1) {
      return { ok: false, code: "INVALID_RULE", message: "not requires exactly one child rule" };
    }
    if (logicalOperator !== "not" && (input.rules.length === 0 || input.rules.length > 50)) {
      return { ok: false, code: "INVALID_RULE", message: "and/or require 1 to 50 child rules" };
    }
    var childRules: JsonRecord[] = [];
    for (var childIndex = 0; childIndex < input.rules.length; childIndex++) {
      var childResult = validateRuleNode(input.rules[childIndex], depth + 1, budget);
      if (!childResult.ok || !childResult.value) return childResult;
      childRules.push(childResult.value);
    }
    return { ok: true, value: { op: logicalOperator, rules: childRules } };
  }

  if (typeof input.trait !== "string" || !isKnownTrait(input.trait)) {
    return { ok: false, code: "UNKNOWN_TRAIT", message: "Rule uses an unsupported trait" };
  }
  if (typeof input.operator !== "string" || !LEAF_OPERATORS[input.operator]) {
    return { ok: false, code: "INVALID_RULE_OPERATOR", message: "Rule uses an unsupported leaf operator" };
  }
  if (!validateLeafValue(input.operator, input.value)) {
    return { ok: false, code: "INVALID_RULE_VALUE", message: "Rule value is invalid for its operator" };
  }
  var leaf: JsonRecord = { trait: input.trait, operator: input.operator };
  if (input.operator !== "present" && input.operator !== "blank") leaf.value = cloneJson(input.value);
  return { ok: true, value: leaf };
}

export function validateRule(input: unknown): ValidationResult<JsonRecord> {
  return validateRuleNode(input, 1, { nodes: 0 });
}

function isMissing(value: unknown): boolean {
  return value === null || value === undefined;
}

function compareValues(left: unknown, right: unknown, operator: string, traitName: string): TruthValue {
  if (isMissing(left)) return "unknown";
  if (left === "unknown") {
    if (operator === "eq") return right === "unknown" ? true : "unknown";
    if (operator === "in" && Array.isArray(right)) {
      for (var unknownIndex = 0; unknownIndex < right.length; unknownIndex++) {
        if (right[unknownIndex] === "unknown") return true;
      }
      return "unknown";
    }
    return "unknown";
  }
  if (operator === "present") return left !== "";
  if (operator === "blank") return left === "";

  if (DATE_TRAITS[traitName] && typeof left === "string") {
    var leftTime = Date.parse(left);
    if (operator === "in" || operator === "not_in") {
      if (!Array.isArray(right)) return false;
      var dateFound = false;
      for (var dateIndex = 0; dateIndex < right.length; dateIndex++) {
        if (typeof right[dateIndex] === "string" && Date.parse(right[dateIndex]) === leftTime) {
          dateFound = true;
          break;
        }
      }
      return operator === "in" ? dateFound : !dateFound;
    }
    if (typeof right !== "string" || Number.isNaN(leftTime) || Number.isNaN(Date.parse(right))) return false;
    right = Date.parse(right);
    left = leftTime;
  }

  if (operator === "eq") return left === right;
  if (operator === "not_eq") return left === right ? false : true;
  if (operator === "in" || operator === "not_in") {
    if (!Array.isArray(right)) return false;
    var found = false;
    for (var index = 0; index < right.length; index++) {
      if (left === right[index]) {
        found = true;
        break;
      }
    }
    return operator === "in" ? found : !found;
  }
  if (typeof left === "number" && typeof right === "number") {
    if (operator === "gte") return left >= right;
    if (operator === "lte") return left <= right;
    if (operator === "gt") return left > right;
    if (operator === "lt") return left < right;
  }
  if (typeof left === "string" && typeof right === "string") {
    if (operator === "gte") return left >= right;
    if (operator === "lte") return left <= right;
    if (operator === "gt") return left > right;
    if (operator === "lt") return left < right;
  }
  return false;
}

function evaluateNode(rule: JsonRecord, profile: CrmProfile): TruthValue {
  if (typeof rule.op === "string") {
    var rules = rule.rules as JsonRecord[];
    if (rule.op === "not") {
      var nested = evaluateNode(rules[0], profile);
      if (nested === "unknown") return "unknown";
      return nested ? false : true;
    }
    var sawUnknown = false;
    for (var index = 0; index < rules.length; index++) {
      var result = evaluateNode(rules[index], profile);
      if (rule.op === "and" && result === false) return false;
      if (rule.op === "or" && result === true) return true;
      if (result === "unknown") sawUnknown = true;
    }
    if (sawUnknown) return "unknown";
    return rule.op === "and";
  }
  var traitName = rule.trait as string;
  return compareValues(profile.traits[traitName], rule.value, rule.operator as string, traitName);
}

export function profileMatchesRule(profile: CrmProfile, rule: JsonRecord): boolean {
  return evaluateNode(rule, profile) === true;
}

export function normalizeSegmentKey(value: unknown): ValidationResult<string> {
  if (typeof value !== "string") {
    return { ok: false, code: "INVALID_SEGMENT_KEY", message: "Segment key is required" };
  }
  var normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{1,63}$/.test(normalized)) {
    return { ok: false, code: "INVALID_SEGMENT_KEY", message: "Segment key must be a stable lowercase key" };
  }
  return { ok: true, value: normalized };
}

export function buildSegment(input: JsonRecord, existing: CrmSegment | null, timestamp: string): ValidationResult<CrmSegment> {
  var keyResult = normalizeSegmentKey(input.key);
  if (!keyResult.ok || !keyResult.value) return failure<CrmSegment>(keyResult);
  var name = normalizeOptionalText(input.name, 120);
  if (!name) return { ok: false, code: "INVALID_SEGMENT_NAME", message: "Segment name is required" };
  var description = normalizeOptionalText(input.description, 1000) || "";
  var kind: "static" | "dynamic" | null = input.kind === "dynamic" ? "dynamic" : input.kind === "static" ? "static" : null;
  if (!kind) return { ok: false, code: "INVALID_SEGMENT_KIND", message: "kind must be static or dynamic" };
  if (existing && existing.kind !== kind) {
    return { ok: false, code: "SEGMENT_KIND_IMMUTABLE", message: "Segment kind cannot change after creation" };
  }
  if (existing && Date.parse(timestamp) < Date.parse(existing.updated_at)) {
    return { ok: false, code: "STALE_SEGMENT_UPDATE", message: "Segment update is older than the current definition" };
  }

  var rule: JsonRecord | null = null;
  if (kind === "dynamic") {
    var ruleResult = validateRule(input.rule);
    if (!ruleResult.ok || !ruleResult.value) return ruleResult as ValidationResult<CrmSegment>;
    rule = ruleResult.value;
  } else if (input.rule !== undefined && input.rule !== null) {
    return { ok: false, code: "STATIC_SEGMENT_RULE", message: "Static segments cannot define a rule" };
  }

  var membershipLimit: number | null = null;
  if (input.membership_limit !== undefined && input.membership_limit !== null && input.membership_limit !== "") {
    var parsedLimit = Number(input.membership_limit);
    if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 1000) {
      return { ok: false, code: "INVALID_MEMBERSHIP_LIMIT", message: "membership_limit must be between 1 and 1000 in V1" };
    }
    membershipLimit = parsedLimit;
  }
  if (kind === "static" && membershipLimit !== null) {
    return { ok: false, code: "STATIC_MEMBERSHIP_LIMIT", message: "membership_limit is only supported for dynamic segments" };
  }

  var groupKey: string | null = null;
  if (input.group_key !== undefined && input.group_key !== null && input.group_key !== "") {
    var groupResult = normalizeSegmentKey(input.group_key);
    if (!groupResult.ok || !groupResult.value) return failure<CrmSegment>(groupResult);
    groupKey = groupResult.value;
  }
  var evaluationMode: "scheduled" | "event" | "hybrid" = "scheduled";
  if (input.evaluation_mode === "event" || input.evaluation_mode === "hybrid") evaluationMode = input.evaluation_mode;
  var isActive = input.is_active === false ? false : true;
  var definitionChanged = !!existing && (
    stableStringify(existing.rule) !== stableStringify(rule) ||
    existing.membership_limit !== membershipLimit ||
    existing.is_active !== isActive
  );

  return {
    ok: true,
    value: {
      id: "segment:" + keyResult.value,
      schema_version: 1,
      key: keyResult.value,
      name: name,
      description: description,
      kind: kind,
      evaluation_mode: evaluationMode,
      rule: rule,
      membership_limit: membershipLimit,
      group_key: groupKey,
      is_active: isActive,
      active_generation: existing && !definitionChanged ? existing.active_generation : null,
      created_at: existing ? existing.created_at : timestamp,
      updated_at: timestamp,
      last_recomputed_at: existing && !definitionChanged ? existing.last_recomputed_at : null
    }
  };
}
