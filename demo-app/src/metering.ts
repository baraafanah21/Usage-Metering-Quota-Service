// HTTP client for the metering API. This is the only module that touches API keys:
// it adds them as headers and never puts them into anything it returns.

const TIMEOUT_MS = 10_000;

/** What the page sees of a call: the request without credentials, and the raw response. */
export interface Exchange {
  request: { method: string; path: string; headers: Record<string, string>; body?: unknown };
  response: { status: number; body: unknown };
}

/** The API answered with a non-2xx status, or could not be reached (status 502). */
export class MeteringError extends Error {
  override name = "MeteringError";
  constructor(
    readonly exchange: Exchange,
    readonly code: string,
  ) {
    super(`${exchange.request.method} ${exchange.request.path} → ${exchange.response.status} ${code}`);
  }
  get status(): number {
    return this.exchange.response.status;
  }
}

type Credential = { kind: "admin"; key: string } | { kind: "account"; key: string } | { kind: "none" };

export class MeteringClient {
  constructor(
    private readonly baseUrl: string,
    private readonly credential: Credential,
  ) {}

  static admin(baseUrl: string, key: string): MeteringClient {
    return new MeteringClient(baseUrl, { kind: "admin", key });
  }

  static account(baseUrl: string, key: string): MeteringClient {
    return new MeteringClient(baseUrl, { kind: "account", key });
  }

  static anonymous(baseUrl: string): MeteringClient {
    return new MeteringClient(baseUrl, { kind: "none" });
  }

  /** Sends one request. Resolves with the exchange on 2xx, throws MeteringError otherwise. */
  async call(method: string, path: string, body?: unknown): Promise<Exchange> {
    const headers: Record<string, string> = {};
    // The shown headers name the credential but never contain it.
    const shownHeaders: Record<string, string> = {};
    if (this.credential.kind === "admin") {
      headers["X-Admin-Key"] = this.credential.key;
      shownHeaders["X-Admin-Key"] = "<operator key, held by the demo server>";
    } else if (this.credential.kind === "account") {
      headers["X-API-Key"] = this.credential.key;
      shownHeaders["X-API-Key"] = "<account key, held by the demo server>";
    }
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      shownHeaders["Content-Type"] = "application/json";
    }

    const request: Exchange["request"] = { method, path, headers: shownHeaders };
    if (body !== undefined) request.body = body;

    let res: Response;
    try {
      res = await fetch(new URL(path, this.baseUrl), {
        method,
        headers,
        ...(body !== undefined && { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      const timedOut = err instanceof DOMException && err.name === "TimeoutError";
      const exchange: Exchange = {
        request,
        response: {
          status: 502,
          body: {
            code: timedOut ? "UPSTREAM_TIMEOUT" : "UPSTREAM_UNREACHABLE",
            detail: timedOut
              ? `No answer from the metering API within ${TIMEOUT_MS / 1000}s`
              : `Could not reach the metering API: ${(err as Error).message}`,
          },
        },
      };
      throw new MeteringError(exchange, timedOut ? "UPSTREAM_TIMEOUT" : "UPSTREAM_UNREACHABLE");
    }

    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = text === "" ? null : JSON.parse(text);
    } catch {
      // Not JSON (a proxy error page, say): show it as text.
    }
    const exchange: Exchange = { request, response: { status: res.status, body: parsed } };
    if (!res.ok) {
      const code = (parsed as { code?: unknown } | null)?.code;
      throw new MeteringError(exchange, typeof code === "string" ? code : `HTTP_${res.status}`);
    }
    return exchange;
  }

  /** Like call(), for when only the response body matters. */
  async json<T>(method: string, path: string, body?: unknown): Promise<T> {
    return (await this.call(method, path, body)).response.body as T;
  }
}
