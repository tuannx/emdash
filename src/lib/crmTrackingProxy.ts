interface PluginEnvelope {
  success: boolean;
  data?: {
    ok?: boolean;
    data?: Record<string, unknown>;
    error?: { code?: string; message?: string };
  };
}

export async function invokeCrmTracking(
  locals: App.Locals,
  request: Request,
  route: "open" | "click" | "unsubscribe",
  token: string,
): Promise<Record<string, unknown> | null> {
  if (!/^[a-f0-9]{48}$/.test(token)) return null;
  const handler = locals.emdash?.handlePublicPluginApiRoute;
  if (!handler) return null;
  const target = new URL(request.url);
  target.search = "";
  target.searchParams.set("token", token);
  const proxiedRequest = new Request(target, {
    method: request.method,
    headers: request.headers,
  });
  const outer = (await handler(
    "crm-studio",
    request.method,
    `/v1/tracking/${route}`,
    proxiedRequest,
  )) as PluginEnvelope;
  if (!outer.success || outer.data?.ok !== true || !outer.data.data) return null;
  return outer.data.data;
}

export const TRACKING_RESPONSE_HEADERS = {
  "Cache-Control": "no-store, no-cache, must-revalidate, private",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};
