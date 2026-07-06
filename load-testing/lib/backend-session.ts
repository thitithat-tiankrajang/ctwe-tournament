/**
 * Minimal authenticated session against the Spring Boot backend (cookie jar + CSRF dance),
 * mirroring exactly what the browser store does: mint a CSRF token on the anonymous session,
 * form-POST /login, then refresh the rotated token. Used by the metrics collector (admin) and
 * the staff-activity writer.
 */

export class BackendSession {
  private readonly origin: URL;
  private readonly username: string;
  private readonly password: string;
  private cookies = new Map<string, string>();
  private csrfToken = "";

  constructor(origin: URL, username: string, password: string) {
    this.origin = origin;
    this.username = username;
    this.password = password;
  }

  private cookieHeader(): string {
    return [...this.cookies.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
  }

  private absorbCookies(response: Response): void {
    for (const header of response.headers.getSetCookie?.() ?? []) {
      const [pair] = header.split(";");
      const eq = pair.indexOf("=");
      if (eq <= 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (value === "") this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  private async me(): Promise<{ authenticated: boolean; csrfToken: string }> {
    const response = await fetch(new URL("/api/auth/me", this.origin), {
      headers: { cookie: this.cookieHeader() },
    });
    this.absorbCookies(response);
    if (!response.ok) throw new Error(`/api/auth/me returned ${response.status}`);
    const body = await response.json() as { authenticated: boolean; csrfToken: string };
    this.csrfToken = body.csrfToken;
    return body;
  }

  async login(): Promise<void> {
    this.cookies.clear();
    await this.me();
    const body = new URLSearchParams({ username: this.username, password: this.password, _csrf: this.csrfToken });
    const response = await fetch(new URL("/login", this.origin), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: this.cookieHeader() },
      body,
      redirect: "manual",
    });
    this.absorbCookies(response);
    if (response.status !== 204) throw new Error(`Login failed for ${this.username}: HTTP ${response.status}`);
    const session = await this.me();
    if (!session.authenticated) throw new Error(`Login for ${this.username} did not establish a session`);
  }

  /** Authenticated request; retries once through a fresh login when the session expired. */
  async request(path: string, init: RequestInit = {}, retry = true): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("cookie", this.cookieHeader());
    const method = (init.method ?? "GET").toUpperCase();
    if (!["GET", "HEAD", "OPTIONS"].includes(method)) headers.set("X-XSRF-TOKEN", this.csrfToken);
    if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
    const response = await fetch(new URL(path, this.origin), { ...init, headers });
    this.absorbCookies(response);
    if (response.status === 401 && retry) {
      await this.login();
      return this.request(path, init, false);
    }
    return response;
  }
}
