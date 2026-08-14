// Minimal external store for the bearer token, shared between the API client
// (which needs to read/clear it outside of React) and React components
// (which subscribe via useSyncExternalStore).

const STORAGE_KEY = 'footprints-qa.token';

type Listener = () => void;

// Local-only deployment: the control plane injects the API token into the served page
// (window.__QA_TOKEN__) so the same-origin UI connects with no login. Falls back to a
// stored token (for `vite dev`, where nothing is injected).
let token: string | null = readInjected() ?? readFromStorage();
let rejected = false;
const listeners = new Set<Listener>();

function readInjected(): string | null {
  const injected = (window as unknown as { __QA_TOKEN__?: string }).__QA_TOKEN__;
  return injected ? injected : null;
}

function readFromStorage(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeToStorage(value: string | null) {
  try {
    if (value === null) {
      window.localStorage.removeItem(STORAGE_KEY);
    } else {
      window.localStorage.setItem(STORAGE_KEY, value);
    }
  } catch {
    // localStorage unavailable (private mode, etc.) — degrade to in-memory only.
  }
}

function emit() {
  for (const listener of listeners) listener();
}

export const authStore = {
  getToken(): string | null {
    return token;
  },
  isRejected(): boolean {
    return rejected;
  },
  setToken(next: string) {
    token = next;
    rejected = false;
    writeToStorage(next);
    emit();
  },
  clearToken(opts?: { rejected?: boolean }) {
    token = null;
    rejected = Boolean(opts?.rejected);
    writeToStorage(null);
    emit();
  },
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};
