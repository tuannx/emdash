import type { APIRoute } from "astro";
import { invokeCrmTracking, TRACKING_RESPONSE_HEADERS } from "../../../lib/crmTrackingProxy";

export const prerender = false;

const handle: APIRoute = async ({ locals, params, request }) => {
  const tracked = await invokeCrmTracking(locals, request, "unsubscribe", params.token || "");
  if (!tracked) return new Response("Not found", { status: 404, headers: TRACKING_RESPONSE_HEADERS });
  if (request.method === "POST") return new Response(null, { status: 200, headers: TRACKING_RESPONSE_HEADERS });
  return new Response("<!doctype html><html><body><h1>Unsubscribe</h1><p>Confirm that you no longer want CRM Studio email.</p><form method=\"post\"><button type=\"submit\">Unsubscribe</button></form></body></html>", {
    status: 200,
    headers: { ...TRACKING_RESPONSE_HEADERS, "Content-Type": "text/html; charset=utf-8" },
  });
};

export const GET = handle;
export const POST = handle;
