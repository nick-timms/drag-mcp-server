export class DragApiError extends Error {
  constructor(
    message: string,
    public code: number,
  ) {
    super(message);
    this.name = "DragApiError";
  }
}

/** Default public base URL for the DragApp API. */
const DEFAULT_API_BASE = "https://app.dragapp.com";

/**
 * Resolve the DragApp API base URL. Defaults to the public edge; override with
 * DRAG_API_BASE (no trailing slash) so a hosted deployment inside the VPC can
 * point at an internal address and avoid hairpinning through the public edge.
 */
function resolveApiBase(): string {
  const configured = process.env.DRAG_API_BASE?.trim();
  return (configured || DEFAULT_API_BASE).replace(/\/+$/, "");
}

/** HTTP client for the DragApp API. Handles both v1.18 and v2 endpoints. Callers pass the full path: client.get("/v2/board") or client.post("/v1.18/teamBoard/list") */
export class DragClient {
  private readonly token: string;
  private readonly clientId: string;
  private readonly base: string;

  constructor(token: string) {
    this.token = token;
    this.clientId = crypto.randomUUID();
    this.base = resolveApiBase();
  }

  async get<T>(path: string, params?: Record<string, string | number>): Promise<T> {
    const url = new URL(`${this.base}${path}`);
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null) {
          url.searchParams.set(key, String(value));
        }
      }
    }
    return this.request<T>("GET", url.toString());
  }

  async post<T>(
    path: string,
    body?: Record<string, unknown>,
    params?: Record<string, string | number>,
  ): Promise<T> {
    const url = new URL(`${this.base}${path}`);
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null) {
          url.searchParams.set(key, String(value));
        }
      }
    }
    return this.request<T>("POST", url.toString(), body);
  }

  async put<T>(path: string, body?: Record<string, unknown>): Promise<T> {
    return this.request<T>("PUT", `${this.base}${path}`, body);
  }

  async delete<T>(path: string, body?: Record<string, unknown>): Promise<T> {
    return this.request<T>("DELETE", `${this.base}${path}`, body);
  }

  private async request<T>(method: string, url: string, body?: Record<string, unknown>): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: this.token,
      "Content-Type": "application/json",
      "Client-ID": this.clientId,
    };

    const response = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "Unknown error");
      throw new DragApiError(
        `Drag API error: ${response.status} — ${text}`,
        response.status,
      );
    }

    const text = await response.text();
    if (!text || text.trim() === "") return {} as T;

    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      // Non-JSON response (e.g. plain "success" string)
      return text as unknown as T;
    }

    // v2 responses are wrapped: { message, error, code, data }
    if (this.isV2Response(json)) {
      if (json.error) {
        throw new DragApiError(
          (json.message as string) || "API error",
          (json.code as number) || response.status,
        );
      }
      return json.data as T;
    }

    // v1.18 error shape: { Error: "...", Success: false } or { Error: {...} }
    if (this.isV1Error(json)) {
      const errVal = (json as Record<string, unknown>).Error;
      const errMsg = typeof errVal === "string" ? errVal : JSON.stringify(errVal);
      throw new DragApiError(errMsg, response.status);
    }

    // v1.18 raw responses — return as-is
    return json as T;
  }

  /** Detect v2 wrapped response: has both "data" and "error" keys */
  private isV2Response(json: unknown): json is Record<string, unknown> {
    return (
      json !== null &&
      typeof json === "object" &&
      !Array.isArray(json) &&
      "data" in json &&
      "error" in json
    );
  }

  /** Detect v1.18 error: has "Error" key with truthy value */
  private isV1Error(json: unknown): boolean {
    return (
      json !== null &&
      typeof json === "object" &&
      !Array.isArray(json) &&
      "Error" in json &&
      !!(json as Record<string, unknown>).Error
    );
  }
}
