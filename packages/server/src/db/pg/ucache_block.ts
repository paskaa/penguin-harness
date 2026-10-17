// ============================================================
// Universal read-through cache (the "PG memory layer").
//
// Every read pays the synchronous bridge: the main thread blocks in Atomics.wait,
// one worker, one PG connection — so a handful of tiny lookups per request multiply
// into seconds of serialized queueing. This layer serves repeating reads from a
// table-aware LRU+TTL cache inside the worker:
//
//   read  (want="rows")  -> cache key = SQL + params; hit returns rows directly
//   write (exec/run)     -> statements are parsed for table names; every cache
//                           entry touching a written table is dropped IMMEDIATELY
//                           (read-after-write stays correct within this process)
//   TTL 300ms            -> bounds staleness from writers outside this process
//                           (tracker, org scripts) to an imperceptible window
//   LRU 3000 entries     -> bounded worker memory (~tens of MB worst case)
//   volatile bypass      -> statements with random()/now()/current_* are never
//                           cached
// ============================================================
const READ_CACHE_TTL = 300;
const READ_CACHE_MAX = 3000;
interface ReadCacheEntry {
  at: number;
  result: Result;
  tables: Set<string>;
}
const readCache = new Map<string, ReadCacheEntry>();
const readCacheIndex = new Map<string, Set<string>>();

const VOLATILE_SQL = /\b(random\s*\(|now\s*\(|clock_timestamp|current_timestamp|current_date|pg_sleep|pg_stat_)\b/i;
const TABLE_RE = /\b(FROM|JOIN|INTO|UPDATE)\s+([A-Za-z_][A-Za-z0-9_.]*)/gi;

function tablesOf(sql: string): Set<string> {
  const tables = new Set<string>();
  TABLE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TABLE_RE.exec(sql)) !== null) {
    tables.add(m[2].split(".").pop()!.toLowerCase());
  }
  return tables;
}

function readCacheKey(req: Req): string {
  return req.sql + "::" + (req.params ? JSON.stringify(req.params) : "");
}

function readCacheGet(key: string): ReadCacheEntry | null {
  const hit = readCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at >= READ_CACHE_TTL) {
    // expired: drop now (also clears its table index) instead of hoarding
    readCache.delete(key);
    for (const t of hit.tables) {
      const keys = readCacheIndex.get(t);
      if (keys) {
        keys.delete(key);
        if (keys.size === 0) readCacheIndex.delete(t);
      }
    }
    return null;
  }
  // LRU refresh
  readCache.delete(key);
  readCache.set(key, hit);
  return hit;
}

function readCachePut(key: string, tables: Set<string>, result: Result): void {
  if (readCache.size >= READ_CACHE_MAX) {
    const oldest = readCache.keys().next().value;
    if (oldest !== undefined) {
      const old = readCache.get(oldest);
      readCache.delete(oldest);
      if (old) {
        for (const t of old.tables) {
          const keys = readCacheIndex.get(t);
          if (keys) {
            keys.delete(oldest);
            if (keys.size === 0) readCacheIndex.delete(t);
          }
        }
      }
    }
  }
  readCache.set(key, { at: Date.now(), result, tables });
  for (const t of tables) {
    let keys = readCacheIndex.get(t);
    if (!keys) {
      keys = new Set<string>();
      readCacheIndex.set(t, keys);
    }
    keys.add(key);
  }
}

function readCacheInvalidate(tables: Set<string>): void {
  for (const t of tables) {
    const keys = readCacheIndex.get(t);
    if (!keys) continue;
    for (const key of keys) readCache.delete(key);
    readCacheIndex.delete(t);
  }
}

