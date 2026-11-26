/** HTTP client: same-origin, cookie auth, CSRF header on every state-changing request. */
let csrf = '';
export const setCsrf = (t: string) => { csrf = t; };

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { 'x-noir-client': '1' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (csrf && method !== 'GET') headers['x-csrf-token'] = csrf;
  let res: Response;
  try {
    res = await fetch(`/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'same-origin' });
  } catch {
    throw new ApiError(0, 'NETWORK', 'Cannot reach the server. Check your connection.');
  }
  const type = res.headers.get('content-type') ?? '';
  const data = type.includes('application/json') ? await res.json() : await res.text();
  if (!res.ok) {
    const d = (typeof data === 'object' && data) || {};
    throw new ApiError(res.status, (d as { code?: string }).code ?? 'ERROR', (d as { error?: string }).error ?? 'Request failed.');
  }
  if (data && typeof data === 'object' && typeof (data as { csrf?: unknown }).csrf === 'string') setCsrf((data as { csrf: string }).csrf);
  return data as T;
}

export const api = {
  get: <T>(p: string) => request<T>('GET', p),
  post: <T>(p: string, b: unknown = {}) => request<T>('POST', p, b),
  put: <T>(p: string, b: unknown) => request<T>('PUT', p, b),
  patch: <T>(p: string, b: unknown) => request<T>('PATCH', p, b),
  del: <T>(p: string) => request<T>('DELETE', p),
};

export const fmt = (n: number | null | undefined) => (n ?? 0).toLocaleString('en-US');
export const credits = (n: number | null | undefined) => `${fmt(n)} ALL`;
