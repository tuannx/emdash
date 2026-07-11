import type { APIRoute } from "astro";
import { invokeCrmTracking, TRACKING_RESPONSE_HEADERS } from "../../../lib/crmTrackingProxy";

export const prerender = false;

const TRANSPARENT_GIF = Uint8Array.from([
  71, 73, 70, 56, 57, 97, 1, 0, 1, 0, 128, 0, 0, 0, 0, 0,
  255, 255, 255, 33, 249, 4, 1, 0, 0, 0, 0, 44, 0, 0, 0, 0,
  1, 0, 1, 0, 0, 2, 2, 68, 1, 0, 59,
]);

export const GET: APIRoute = async ({ locals, params, request }) => {
  const tracked = await invokeCrmTracking(locals, request, "open", params.token || "");
  return new Response(tracked ? TRANSPARENT_GIF : null, {
    status: tracked ? 200 : 404,
    headers: {
      ...TRACKING_RESPONSE_HEADERS,
      "Content-Type": "image/gif",
      "Content-Length": tracked ? String(TRANSPARENT_GIF.byteLength) : "0",
    },
  });
};
