// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------
// __API_BASE__ is replaced at build time by Vite's define config.  At runtime
// window.__API_BASE__ can be injected by the server (Nginx / config.json) to
// override the build-time value.  If neither is present we fall back to the
// current origin so the SPA and API can be co-located.
// ---------------------------------------------------------------------------

declare const __API_BASE__: string;

export function getApiBase(): string {
  // 1. Runtime override (server-injected)
  if (typeof window !== 'undefined' && window.__API_BASE__) {
    return window.__API_BASE__;
  }
  // 2. Build-time constant (may be empty string if API_URL was not set)
  if (typeof __API_BASE__ !== 'undefined' && __API_BASE__) {
    return __API_BASE__;
  }
  // 3. Co-located fallback
  return window.location.origin;
}

// ---------------------------------------------------------------------------
// Shared fetch wrapper
// ---------------------------------------------------------------------------

async function apiFetch<T>(
  input: RequestInfo,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(input, init);
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string; message?: string };
      message = body.error ?? body.message ?? message;
    } catch {
      // ignore JSON parse error — keep status-code message
    }
    throw new Error(message);
  }
  return res.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// Response types
// ---------------------------------------------------------------------------

export interface QrStartResponse {
  requestId: string;
  qrCode: string;
  url: string;
}

export interface StatusResponse {
  status: string;
  claims?: Record<string, unknown>;
  failureReason?: string;
}

export interface EamTokenResponse {
  id_token?: string;
  state?: string;
  redirect_uri?: string;
  status?: string;
}

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

export function loginStart(): Promise<QrStartResponse> {
  return apiFetch<QrStartResponse>(`${getApiBase()}/api/login/start`, {
    method: 'POST',
  });
}

export function loginStatus(requestId: string): Promise<StatusResponse> {
  if (!requestId) {
    return Promise.reject(new Error('requestId is required'));
  }
  return apiFetch<StatusResponse>(
    `${getApiBase()}/api/login/status/${encodeURIComponent(requestId)}`,
  );
}

// ---------------------------------------------------------------------------
// Issuance
// ---------------------------------------------------------------------------

export function issueStart(): Promise<QrStartResponse> {
  return apiFetch<QrStartResponse>(`${getApiBase()}/api/issue/start`, {
    method: 'POST',
  });
}

// ---------------------------------------------------------------------------
// EAM (WorkSpaces / broker sessions)
// ---------------------------------------------------------------------------

export function eamSessionStart(sessionId: string): Promise<QrStartResponse> {
  if (!sessionId) {
    return Promise.reject(new Error('sessionId is required'));
  }
  return apiFetch<QrStartResponse>(
    `${getApiBase()}/api/eam/session/${encodeURIComponent(sessionId)}/start`,
    { method: 'POST' },
  );
}

export function eamSessionToken(sessionId: string): Promise<EamTokenResponse> {
  if (!sessionId) {
    return Promise.reject(new Error('sessionId is required'));
  }
  return apiFetch<EamTokenResponse>(
    `${getApiBase()}/api/eam/session/${encodeURIComponent(sessionId)}/token`,
  );
}
