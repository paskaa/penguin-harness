/**
 * The usage read's short-TTL response cache, in one place so that every writer of a PRICE
 * can drop it.
 *
 * Why the cache exists: the dashboard re-requests the same aggregates several times a
 * minute, and a miss costs 4–6 grouped scans over a six-figure `usage_records` table.
 *
 * Why it must be droppable: the cached body carries COSTS, and a cost is (tokens × the
 * price in force NOW). Everywhere else the usage path looks a price up fresh on each read
 * (`UsageService.buildResponse` says so explicitly — "a cost page showing yesterday's rate
 * is worse than a slow one"), so a TTL-only cache here would quietly resurrect the stale
 * price that design exists to avoid: edit a model's price, restore defaults, or change a
 * promotion, and the Cost center would keep showing the old figure for up to 30 s. The
 * models routes therefore call {@link invalidateUsageCache} after any write that can move
 * a price.
 */

/** Bounded size; a full map is dropped wholesale rather than evicted one by one. */
const MAX_ENTRIES = 200;

/**
 * 30 s, aligned with the 30 s bucket the cache key quantizes rolling windows to: at most one
 * aggregate re-run per bucket per shape, so charts lag at most 30 s.
 */
export const USAGE_TTL_MS = 30_000;

/** One cached response body, keyed by the full request shape (project + args + viewer scope). */
const cache = new Map<string, { at: number; body: unknown }>();
/** Identical requests in flight share one query instead of doubling it. */
const inFlight = new Map<string, Promise<unknown>>();

/**
 * Rolling `fromTs`/`toTs` change on every request; quantize them to 30 s buckets in the KEY
 * only, so consecutive polls share entries. The served body keeps its own exact window —
 * the difference is under 30 s, invisible on a chart.
 */
export function usageQuantizeKey(key: string): string {
  return key.replace(/"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[^"]*"/g, (m0) => {
    const ms = Date.parse(JSON.parse(m0));
    if (Number.isNaN(ms)) return m0;
    return JSON.stringify(new Date(Math.floor(ms / 30000) * 30000).toISOString());
  });
}

/** The cached body for `key` while it is still fresh, else null. */
export function cachedUsageBody(key: string): unknown | null {
  const hit = cache.get(key);
  if (hit === undefined || Date.now() - hit.at >= USAGE_TTL_MS) return null;
  return hit.body;
}

/** The in-flight query for `key`, if one is running. */
export function pendingUsageBody(key: string): Promise<unknown> | undefined {
  return inFlight.get(key);
}

/** Runs `compute` as the one query for `key` while it is in flight, then caches its body. */
export async function computeUsageBody(
  key: string,
  compute: () => Promise<unknown>,
  reply: (body: unknown) => Response,
): Promise<Response> {
  let pending = inFlight.get(key);
  if (pending === undefined) {
    pending = compute().finally(() => inFlight.delete(key));
    inFlight.set(key, pending);
  }
  const body = await pending;
  if (cache.size > MAX_ENTRIES) cache.clear();
  cache.set(key, { at: Date.now(), body });
  return reply(body);
}

/**
 * Drops cached usage bodies: one Project's when `projectId` is given (every shape for it,
 * since the key is prefixed with the Project), all of them otherwise.
 */
export function invalidateUsageCache(projectId?: string): void {
  if (projectId === undefined) {
    cache.clear();
    return;
  }
  const prefix = `${projectId}::`;
  for (const key of [...cache.keys()]) {
    if (key.startsWith(prefix)) cache.delete(key);
  }
}
