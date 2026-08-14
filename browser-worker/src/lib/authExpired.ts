import fs from 'node:fs';
import path from 'node:path';

// AUTH_EXPIRED sentinel (arch §3.2): fixtures.ts drops a file named AUTH_EXPIRED under the
// run's output dir when a 401 is observed on an authenticated same-origin call mid-run.
// Its presence anywhere under the run output dir means the session went stale, not an app bug.
export function findAuthExpiredFile(rootDir: string): string | null {
  if (!fs.existsSync(rootDir)) return null;

  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    const full = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      const found = findAuthExpiredFile(full);
      if (found) return found;
    } else if (entry.name === 'AUTH_EXPIRED') {
      return full;
    }
  }
  return null;
}
