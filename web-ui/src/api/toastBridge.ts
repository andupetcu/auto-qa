// Bridges API-layer errors (thrown outside of React) to the Fluent Toaster
// mounted near the root. A component calls `registerToastHandler` once with
// a function backed by `useToastController`; the API client calls `notifyError`.

type ToastHandler = (title: string, detail: string) => void;

let handler: ToastHandler | null = null;

export function registerToastHandler(next: ToastHandler | null) {
  handler = next;
}

export function notifyError(title: string, detail: string) {
  if (handler) {
    handler(title, detail);
  } else {
    // Fallback before the Toaster mounts (e.g. very early errors).
    console.error(`${title}: ${detail}`);
  }
}
