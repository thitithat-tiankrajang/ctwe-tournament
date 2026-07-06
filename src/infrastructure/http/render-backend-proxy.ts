const LOCAL_BACKEND_URL = "http://127.0.0.1:8080";

function backendOrigin(): URL {
  const configured = process.env.BACKEND_URL?.trim();
  const value = configured || (process.env.NODE_ENV === "development" ? LOCAL_BACKEND_URL : "");

  if (!value) {
    throw new Error("BACKEND_URL is not configured");
  }

  const origin = new URL(value);
  const isLocal = origin.hostname === "127.0.0.1" || origin.hostname === "localhost";
  if (origin.protocol !== "https:" && !isLocal) {
    throw new Error("BACKEND_URL must use HTTPS outside local development");
  }
  return origin;
}

/**
 * Keep browser traffic same-origin while Spring Boot remains a private implementation detail.
 * This preserves Secure/HttpOnly session cookies and streams SSE without requiring CORS.
 */
export async function proxyToRender(request: Request): Promise<Response> {
  try {
    const incoming = new URL(request.url);
    const upstream = backendOrigin();
    upstream.pathname = incoming.pathname;
    upstream.search = incoming.search;

    const headers = new Headers(request.headers);
    headers.delete("host");
    headers.delete("content-length");
    headers.delete("connection");
    headers.delete("transfer-encoding");
    // Let fetch negotiate upstream compression (gzip). Both workerd and Node decompress the body
    // transparently before we read/pipe it, so the Render->edge transfer stays small while the
    // code below only ever handles identity bytes. (The old identity override predates Workers.)
    headers.delete("accept-encoding");
    headers.set("x-forwarded-host", incoming.host);
    headers.set("x-forwarded-proto", incoming.protocol.replace(":", ""));

    const init: RequestInit & { duplex?: "half" } = {
      method: request.method,
      headers,
      redirect: "manual",
    };
    if (request.method !== "GET" && request.method !== "HEAD") {
      init.body = request.body;
      init.duplex = "half";
    }

    const response = await fetch(upstream, init);
    const responseHeaders = new Headers(response.headers);
    for (const name of [
      "connection",
      "keep-alive",
      "proxy-authenticate",
      "proxy-authorization",
      "te",
      "trailer",
      "transfer-encoding",
      "upgrade",
    ]) {
      responseHeaders.delete(name);
    }
    // The runtime already decompressed the upstream body, so its encoding/length metadata no
    // longer describes what we forward; Cloudflare re-compresses at the edge per the client's
    // own Accept-Encoding.
    responseHeaders.delete("content-encoding");
    responseHeaders.delete("content-length");

    const responseInit: ResponseInit = {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    };

    // Fetch forbids bodies for these statuses, even empty ones.
    if (request.method === "HEAD" || response.status === 204 || response.status === 205 || response.status === 304) {
      return new Response(null, responseInit);
    }

    // Stream everything — SSE and finite bodies alike. The previous arrayBuffer() copy was a
    // Vercel workaround; on Workers it buffered every staff card payload (hundreds of KB) in
    // memory per request and was the proxy's single largest CPU + latency cost.
    return new Response(response.body, responseInit);
  } catch (error) {
    console.error("Backend proxy request failed", error);
    return Response.json(
      {
        message: "Backend service is unavailable",
        error: error instanceof Error ? error.message : String(error),
        backendUrl: process.env.BACKEND_URL ?? null,
      },
      {
        status: 503,
        headers: {
          "Cache-Control": "no-store",
        },
      },
    );
  }
}
