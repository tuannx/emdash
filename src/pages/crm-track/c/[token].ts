import type { APIRoute } from "astro";
import { invokeCrmTracking, TRACKING_RESPONSE_HEADERS } from "../../../lib/crmTrackingProxy";

export const prerender = false;

export const GET: APIRoute = async ({ locals, params, request }) => {
  const tracked = await invokeCrmTracking(locals, request, "click", params.token || "");
  const location = typeof tracked?.location === "string" ? tracked.location : "";
  let safeLocation = "";
  try {
    const parsed = new URL(location);
    if (parsed.protocol === "https:" && !parsed.username && !parsed.password) safeLocation = parsed.toString();
  } catch {
    safeLocation = "";
  }
  if (!safeLocation) return new Response(null, { status: 404, headers: TRACKING_RESPONSE_HEADERS });
  return new Response(null, { status: 302, headers: { ...TRACKING_RESPONSE_HEADERS, Location: safeLocation } });
};
