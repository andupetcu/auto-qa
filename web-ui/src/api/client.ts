import { authStore } from '../auth/authStore';
import { notifyError } from './toastBridge';
import type { ProblemDetails } from './types';

const API_BASE = '/api/v1';

export class ApiError extends Error {
  status: number;
  problem: ProblemDetails;

  constructor(problem: ProblemDetails) {
    super(problem.detail || problem.title || 'Request failed');
    this.status = problem.status;
    this.problem = problem;
  }
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  query?: Record<string, string | number | boolean | undefined | null>;
  /** Skip surfacing this error via the global Toaster (caller handles it). */
  silent?: boolean;
}

function buildUrl(path: string, query?: RequestOptions['query']): string {
  const url = new URL(`${API_BASE}${path}`, window.location.origin);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null) continue;
      url.searchParams.set(key, String(value));
    }
  }
  return url.pathname + url.search;
}

async function parseProblem(res: Response): Promise<ProblemDetails> {
  try {
    const data = (await res.json()) as Partial<ProblemDetails>;
    return {
      title: data.title ?? res.statusText ?? 'Request failed',
      status: data.status ?? res.status,
      detail: data.detail ?? 'The server did not provide further detail.',
      ...data,
    };
  } catch {
    return {
      title: res.statusText || 'Request failed',
      status: res.status,
      detail: `Request failed with status ${res.status}.`,
    };
  }
}

export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, headers = {}, query, silent } = options;
  const token = authStore.getToken();

  const finalHeaders: Record<string, string> = {
    Accept: 'application/json',
    ...headers,
  };
  if (token) {
    finalHeaders.Authorization = `Bearer ${token}`;
  }
  if (body !== undefined) {
    finalHeaders['Content-Type'] = 'application/json';
  }

  let res: Response;
  try {
    res = await fetch(buildUrl(path, query), {
      method,
      headers: finalHeaders,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    const problem: ProblemDetails = {
      title: 'Network error',
      status: 0,
      detail: err instanceof Error ? err.message : 'Could not reach the control plane.',
    };
    if (!silent) notifyError(problem.title, problem.detail);
    throw new ApiError(problem);
  }

  if (res.status === 401) {
    authStore.clearToken({ rejected: true });
    const problem: ProblemDetails = {
      title: 'Token rejected',
      status: 401,
      detail: 'Your session token was rejected. Reconnect with a valid token.',
    };
    throw new ApiError(problem);
  }

  if (!res.ok) {
    const problem = await parseProblem(res);
    if (!silent) notifyError(problem.title, problem.detail);
    throw new ApiError(problem);
  }

  if (res.status === 204) {
    return undefined as T;
  }

  const contentType = res.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    return undefined as T;
  }

  return (await res.json()) as T;
}

export const api = {
  get: <T>(path: string, query?: RequestOptions['query']) =>
    apiRequest<T>(path, { method: 'GET', query }),
  post: <T>(path: string, body?: unknown, headers?: Record<string, string>) =>
    apiRequest<T>(path, { method: 'POST', body, headers }),
  patch: <T>(path: string, body?: unknown) => apiRequest<T>(path, { method: 'PATCH', body }),
  put: <T>(path: string, body?: unknown) => apiRequest<T>(path, { method: 'PUT', body }),
  del: <T>(path: string) => apiRequest<T>(path, { method: 'DELETE' }),
};
