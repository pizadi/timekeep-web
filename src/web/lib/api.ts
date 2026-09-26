// REST client: cookie-authenticated, CSRF double-submit header, device id,
// error envelope handling, server-clock offset capture (FR-S2/NFR-6).
import { CSRF_HEADER, DEVICE_HEADER } from '../../shared/constants';

// localStorage: a device is a browser, not a tab — sessionStorage made every
// tab a distinct "device", multiplying hello fan-out (audit §5.13).
const deviceId: string = (() => {
  try {
    let d = localStorage.getItem('tk.device');
    if (!d) {
      d = Array.from(crypto.getRandomValues(new Uint8Array(8)))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
      localStorage.setItem('tk.device', d);
    }
    return d;
  } catch {
    return 'unknown';
  }
})();

export const getDeviceId = () => deviceId;

/** Server time minus client time (ms) — display clocks are corrected by this (FR-S2). */
export let serverOffsetMs = 0;
export const nowMs = () => Date.now() + serverOffsetMs;

function readCsrfCookie(): string | null {
  const m = document.cookie.match(/(?:^|;\s*)tk_csrf=([A-Za-z0-9]+)/);
  return m ? m[1]! : null;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export async function api<T = unknown>(
  path: string,
  opts: { method?: string; body?: unknown; signal?: AbortSignal } = {},
): Promise<T> {
  const headers: Record<string, string> = { [DEVICE_HEADER]: deviceId };
  const method = opts.method ?? 'GET';
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  const csrf = readCsrfCookie();
  if (csrf) headers[CSRF_HEADER] = csrf;

  const res = await fetch(`/api${path}`, {
    method,
    headers,
    credentials: 'same-origin',
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    signal: opts.signal,
  });

  // capture server clock offset from Date header (best-effort, rounded to 0)
  const dateHeader = res.headers.get('date');
  if (dateHeader) {
    const server = Date.parse(dateHeader);
    if (Number.isFinite(server)) serverOffsetMs = server - Date.now();
  }

  if (res.status === 204) return undefined as T;
  const isJson = (res.headers.get('content-type') ?? '').includes('application/json');
  const data = isJson ? await res.json().catch(() => null) : null;

  if (!res.ok) {
    // Global 401 handling (audit: an expired session used to strand the app in
    // an endless toast loop — the store signs the session out on this event).
    if (res.status === 401 && !path.startsWith('/auth/')) {
      window.dispatchEvent(new CustomEvent('tk:unauthorized'));
    }
    const err = (data as any)?.error;
    throw new ApiError(res.status, err?.code ?? 'error', err?.message ?? res.statusText, err?.details);
  }
  return data as T;
}

export const wsUrl = (): string => {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/api/ws?device=${encodeURIComponent(deviceId)}`;
};
