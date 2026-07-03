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
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  } catch (error) {
    console.error("Backend proxy request failed", error);
    return Response.json(
      { message: "Backend service is unavailable" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
