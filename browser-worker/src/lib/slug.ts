// Deterministic, stable artifact key slugging: lowercase, alnum+dash, no leading/trailing
// dash, capped length. Used to build the on-disk / storage_key directory name per result.
export function slugify(input: string, maxLen = 60): string {
  const cleaned = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned.slice(0, maxLen).replace(/-+$/g, '');
}

export function resultKey(role: string, testName: string): string {
  return slugify(`${role}-${testName}`);
}
