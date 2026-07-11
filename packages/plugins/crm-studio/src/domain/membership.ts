import type { CrmProfile, JsonRecord } from "../types.js";
import { stableStringify } from "./profile.js";

export function membershipIdentity(segmentKey: string, profileId: string): string {
  return segmentKey + "::" + profileId;
}

export function membershipStateId(segmentKey: string, profileId: string): string {
  return "state|" + segmentKey + "|" + profileId;
}

export function membershipHistoryId(segmentKey: string, profileId: string, requestId: string): string {
  return "membership|" + segmentKey + "|" + profileId + "|" + requestId;
}

export function eventId(eventType: string, requestId: string, identity: string): string {
  return "event|" + eventType + "|" + requestId + "|" + identity;
}

export function receiptId(requestId: string): string {
  return "receipt|" + requestId;
}

function profileSortKey(profile: CrmProfile): string {
  if (profile.emdash_user_id) return "0:" + profile.emdash_user_id;
  return "1:" + profile.id;
}

export function selectBoundedProfiles(profiles: CrmProfile[], membershipLimit: number | null): CrmProfile[] {
  var selected = profiles.slice();
  selected.sort(function(left, right) {
    return profileSortKey(left).localeCompare(profileSortKey(right));
  });
  if (membershipLimit !== null && selected.length > membershipLimit) return selected.slice(0, membershipLimit);
  return selected;
}

export async function requestPayloadFingerprint(route: string, input: JsonRecord): Promise<string> {
  var serialized = stableStringify({ route: route, input: input });
  var bytes = new TextEncoder().encode(serialized);
  var digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  var values = new Uint8Array(digest);
  var parts: string[] = [];
  for (var index = 0; index < values.length; index++) {
    parts.push(values[index].toString(16).padStart(2, "0"));
  }
  return parts.join("");
}
