/**
 * Short-lived browser cache for the paged saved-audit endpoints.
 *
 * Saved audits are immutable while they are being reviewed, so retaining a
 * small number of already-viewed result windows avoids re-requesting the same
 * data whenever React unmounts a tab and mounts it again. This deliberately
 * lives only in JavaScript memory: a refresh, logout, or closed tab starts a
 * new cache and it never writes audit data to localStorage.
 */
type WindowKind = 'pages' | 'links' | 'resources';
type QueryOptions = Record<string, string | number>;

const MAX_CACHED_WINDOWS = 100;
const windows = new Map<string, unknown>();
const pendingWindows = new Map<string, Promise<unknown>>();

function keyFor(kind: WindowKind, crawlId: string, options: QueryOptions) {
  const query = Object.entries(options)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `${name}=${String(value)}`)
    .join('&');
  return `${kind}:${crawlId}:${query}`;
}

function touch<T>(key: string): T | undefined {
  const value = windows.get(key) as T | undefined;
  if (value === undefined) return undefined;
  // Map insertion order gives us a compact least-recently-used cache.
  windows.delete(key);
  windows.set(key, value);
  return value;
}

function store<T>(key: string, value: T) {
  windows.delete(key);
  windows.set(key, value);
  while (windows.size > MAX_CACHED_WINDOWS) windows.delete(windows.keys().next().value!);
  return value;
}

export function getSavedAuditWindow<T>(kind: WindowKind, crawlId: string, options: QueryOptions): T | undefined {
  return touch<T>(keyFor(kind, crawlId, options));
}

export function loadSavedAuditWindow<T>(kind: WindowKind, crawlId: string, options: QueryOptions, load: () => Promise<T>): Promise<T> {
  const key = keyFor(kind, crawlId, options);
  const cached = touch<T>(key);
  if (cached !== undefined) return Promise.resolve(cached);

  const pending = pendingWindows.get(key) as Promise<T> | undefined;
  if (pending) return pending;

  const request = load()
    .then(result => store(key, result))
    .finally(() => { pendingWindows.delete(key); });
  pendingWindows.set(key, request);
  return request;
}

export function clearSavedAuditCache(crawlId?: string) {
  if (!crawlId) {
    windows.clear();
    pendingWindows.clear();
    return;
  }
  const suffix = `:${crawlId}:`;
  for (const key of windows.keys()) if (key.includes(suffix)) windows.delete(key);
  for (const key of pendingWindows.keys()) if (key.includes(suffix)) pendingWindows.delete(key);
}
