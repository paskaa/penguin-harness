/**
 * DeepSeek Harness (dsh) plugin indexes: the other plugin market this server can list.
 *
 * A dsh market is one static JSON file — `docs/user/guide/plugin-market.md` upstream calls it a
 * plugin index — served from anywhere. Its shape is NOT the plugin index this server's own
 * registry speaks (`plugin/registry.ts`): one row per plugin carrying every listed version, and
 * a `source` pinned per version. This module reads that document, checks it, and flattens it to
 * the row shape the dsh-market page installs from.
 *
 * Nothing here is offered as a PenguinHarness plugin: a dsh plugin is a Cordis plugin that runs
 * inside the dsh host, which this server does not have. What a card may install is the part of a
 * dsh package that HAS a Penguin equivalent — its skills and its MCP servers — built into a
 * Penguin package by `plugin/dsh-adapt.ts`. So these entries never join `GET /api/plugins/registry`
 * (a listing that page installs server modules from): the dsh-market page reads them here.
 *
 * The sources an operator added live in `<root>/dsh-market.json`, beside the data root's other
 * deployment-wide settings.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { userAgent } from "@prismshadow/penguin-core";
import type { DshEntryItem, DshText, DshVersionSource } from "../api/types.js";

/** The wire shape lives in api/types.ts; this module reads and re-exports it. */
export type { DshEntryItem, DshText, DshVersionSource };
/** One plugin of one source, with the version a card offers: the highest release. */
export type DshEntry = DshEntryItem;

/** One index source an operator added. */
export interface DshSource {
  id: string;
  /** The index file's URL, as entered. */
  url: string;
  /** The index's own title for display; empty until it has been read once. */
  title: string;
  addedAt: number;
}

/** One version row of the index, as read (unknown members are ignored). */
export interface DshIndexVersion {
  version: string;
  publishTimestamp?: number;
  source: DshVersionSource;
  engines?: { dsh?: string };
}

/** One plugin row of the index. */
export interface DshIndexPlugin {
  name: string;
  title?: DshText;
  description?: DshText;
  icon?: string;
  author?: string;
  homepage?: string;
  repository?: { url?: string; directory?: string };
  metadata?: { category?: string; keywords?: string[]; labels?: string[] };
  versions: DshIndexVersion[];
}

/** A checked index document. */
export interface DshIndex {
  title: DshText;
  plugins: DshIndexPlugin[];
  /** The index's categories, by id (`metadata.categories`): an id → its display title. */
  categories: Record<string, DshText>;
}

/** A source with what reading it produced, for the page's source list. */
export interface DshSourceState extends DshSource {
  /** Plugins the source lists; 0 when it could not be read. */
  plugins: number;
  /** Why the source could not be read, or was being read when the answer was built. */
  error?: string;
  /** It had not answered when this listing was built; its entries arrive on a later read. */
  pending?: boolean;
}

/** Where the operator's sources are kept. */
export function dshSourcesFile(root: string): string {
  return path.join(root, "dsh-market.json");
}

/** A URL an index source may use: http(s), no credentials, no fragment. */
export function checkSourceUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "不是一个 URL";
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return "只接受 http(s) 地址";
  if (url.username !== "" || url.password !== "") return "地址里不能带用户名或密码";
  if (url.hash !== "") return "地址里不能带 # 片段";
  return null;
}

/** The operator's sources, in the order they were added; an unreadable file reads as none. */
export async function readDshSources(root: string): Promise<DshSource[]> {
  let raw: string;
  try {
    raw = await fs.readFile(dshSourcesFile(root), "utf8");
  } catch {
    return [];
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  const out: DshSource[] = [];
  for (const item of data) {
    const row = item as Partial<DshSource>;
    if (typeof row.id !== "string" || typeof row.url !== "string") continue;
    out.push({
      id: row.id,
      url: row.url,
      title: typeof row.title === "string" ? row.title : "",
      addedAt: typeof row.addedAt === "number" ? row.addedAt : 0,
    });
  }
  return out;
}

async function writeDshSources(root: string, sources: readonly DshSource[]): Promise<void> {
  const file = dshSourcesFile(root);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(sources, null, 2)}\n`, "utf8");
  await fs.rename(tmp, file);
}

/**
 * One writer at a time, for the sources file.
 *
 * A read-modify-write of a small JSON file is a lost update when two admins save at once: both
 * read the same list and the second write erases the first. Serializing the three writes here is
 * the whole fix; reads stay free.
 */
let writeQueue: Promise<unknown> = Promise.resolve();
function serialized<T>(work: () => Promise<T>): Promise<T> {
  const run = writeQueue.then(work, work);
  writeQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** Adds a source, or refuses a URL that is unusable or already listed. */
export async function addDshSource(
  root: string,
  url: string,
  now = Date.now(),
): Promise<DshSource> {
  const fault = checkSourceUrl(url);
  if (fault !== null) throw new Error(`索引源地址不可用：${fault}`);
  return serialized(async () => {
    const sources = await readDshSources(root);
    const existing = sources.find((s) => s.url === url);
    if (existing !== undefined) return existing;
    const added: DshSource = { id: randomUUID(), url, title: "", addedAt: now };
    await writeDshSources(root, [...sources, added]);
    return added;
  });
}

/** Removes one source by id; answers whether it was there. */
export async function removeDshSource(root: string, id: string): Promise<boolean> {
  return serialized(async () => {
    const sources = await readDshSources(root);
    const kept = sources.filter((s) => s.id !== id);
    if (kept.length === sources.length) return false;
    await writeDshSources(root, kept);
    return true;
  });
}

/** Records the title an index calls itself, so the source list reads as something. */
export async function rememberSourceTitle(root: string, id: string, title: string): Promise<void> {
  await serialized(async () => {
    const sources = await readDshSources(root);
    const at = sources.findIndex((s) => s.id === id);
    if (at < 0 || sources[at]!.title === title) return;
    const next = [...sources];
    next[at] = { ...next[at]!, title };
    await writeDshSources(root, next);
  });
}

/** The English text of a localized field (an index must give `en`; a string is its own). */
export function textEn(value: DshText | undefined, fallback = ""): string {
  if (value === undefined) return fallback;
  if (typeof value === "string") return value;
  return value.en ?? value.zh ?? Object.values(value)[0] ?? fallback;
}

/** The Chinese text of a localized field, or "" when the index gives none. */
export function textZh(value: DshText | undefined): string {
  if (value === undefined) return "";
  if (typeof value === "string") return "";
  return value.zh ?? "";
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function readText(value: unknown): DshText | undefined {
  if (typeof value === "string") return value;
  if (!isRecord(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, text] of Object.entries(value)) {
    if (typeof text === "string") out[key] = text;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function readSource(value: unknown, at: string): DshVersionSource {
  if (!isRecord(value)) throw new Error(`${at}.source 缺失`);
  if (value.type === "npm") {
    return typeof value.registry === "string"
      ? { type: "npm", registry: value.registry }
      : { type: "npm" };
  }
  if (value.type === "git") {
    return {
      type: "git",
      ...(typeof value.url === "string" ? { url: value.url } : {}),
      ...(typeof value.commit === "string" ? { commit: value.commit } : {}),
      ...(typeof value.path === "string" ? { path: value.path } : {}),
    };
  }
  throw new Error(`${at}.source.type 必须是 npm 或 git`);
}

/**
 * Checks one index document and reads it. A malformed document throws with the JSON path of the
 * offending value: the index is one publisher's single artifact, so a bad row kills it rather
 * than being skipped (the same rule upstream's reader states).
 */
export function parseDshIndex(data: unknown, label = "index"): DshIndex {
  if (!isRecord(data)) throw new Error(`${label}：不是一个 JSON 对象`);
  if (data.format !== 1) throw new Error(`${label}：format 必须是 1`);
  if (!Array.isArray(data.plugins)) throw new Error(`${label}：plugins 必须是数组`);
  const plugins: DshIndexPlugin[] = [];
  const seen = new Set<string>();
  for (const [index, raw] of data.plugins.entries()) {
    const at = `${label}.plugins[${index}]`;
    if (!isRecord(raw)) throw new Error(`${at}：不是一个对象`);
    if (typeof raw.name !== "string" || raw.name === "") throw new Error(`${at}.name 缺失`);
    if (seen.has(raw.name)) throw new Error(`${at}.name 重复：${raw.name}`);
    seen.add(raw.name);
    if (!Array.isArray(raw.versions) || raw.versions.length === 0) {
      throw new Error(`${at}.versions 必须是非空数组`);
    }
    const versions: DshIndexVersion[] = [];
    for (const [vi, vraw] of raw.versions.entries()) {
      const vat = `${at}.versions[${vi}]`;
      if (!isRecord(vraw)) throw new Error(`${vat}：不是一个对象`);
      if (typeof vraw.version !== "string" || vraw.version === "") {
        throw new Error(`${vat}.version 缺失`);
      }
      versions.push({
        version: vraw.version,
        ...(typeof vraw.publishTimestamp === "number"
          ? { publishTimestamp: vraw.publishTimestamp }
          : {}),
        source: readSource(vraw.source, vat),
        ...(isRecord(vraw.engines) && typeof vraw.engines.dsh === "string"
          ? { engines: { dsh: vraw.engines.dsh } }
          : {}),
      });
    }
    plugins.push({
      name: raw.name,
      ...(readText(raw.title) !== undefined ? { title: readText(raw.title) } : {}),
      ...(readText(raw.description) !== undefined
        ? { description: readText(raw.description) }
        : {}),
      ...(typeof raw.icon === "string" ? { icon: raw.icon } : {}),
      ...(typeof raw.author === "string" ? { author: raw.author } : {}),
      ...(typeof raw.homepage === "string" ? { homepage: raw.homepage } : {}),
      ...(isRecord(raw.repository) && typeof raw.repository.url === "string"
        ? { repository: { url: raw.repository.url } }
        : {}),
      ...(isRecord(raw.metadata)
        ? {
            metadata: {
              ...(typeof raw.metadata.category === "string"
                ? { category: raw.metadata.category }
                : {}),
              ...(Array.isArray(raw.metadata.keywords)
                ? {
                    keywords: raw.metadata.keywords.filter(
                      (k): k is string => typeof k === "string",
                    ),
                  }
                : {}),
            },
          }
        : {}),
      versions,
    });
  }
  const categories: Record<string, DshText> = {};
  const metadata = isRecord(data.metadata) ? data.metadata : undefined;
  const declared =
    metadata !== undefined && isRecord(metadata.categories) ? metadata.categories : undefined;
  if (declared !== undefined) {
    for (const [id, value] of Object.entries(declared)) {
      const title = isRecord(value) ? readText(value.title) : readText(value);
      if (title !== undefined) categories[id] = title;
    }
  }
  return { title: readText(data.title) ?? "", plugins, categories };
}

/** A version string, split for ordering: numeric parts, the prerelease tag, build metadata. */
function versionKey(version: string): {
  parts: number[];
  pre: boolean;
  tag: string;
  build: string;
} {
  const plus = version.indexOf("+");
  const withoutBuild = plus < 0 ? version : version.slice(0, plus);
  const build = plus < 0 ? "" : version.slice(plus + 1);
  const dash = withoutBuild.indexOf("-");
  const core = dash < 0 ? withoutBuild : withoutBuild.slice(0, dash);
  const tag = dash < 0 ? "" : withoutBuild.slice(dash + 1);
  return {
    parts: core.split(".").map((p) => Number.parseInt(p, 10) || 0),
    pre: dash >= 0,
    tag,
    build,
  };
}

/**
 * Semver order, descending: a release above its prereleases, then numeric parts, then a
 * prerelease tag alphabetically. Enough for "which version does the card offer" and for listing
 * a plugin's versions; build metadata is ignored, as semver says to.
 */
export function compareVersions(a: string, b: string): number {
  const ka = versionKey(a);
  const kb = versionKey(b);
  // Core first, exactly as semver orders: 1.2.0-rc.1 comes after 1.1.0 and before 1.2.0.
  for (let i = 0; i < Math.max(ka.parts.length, kb.parts.length); i += 1) {
    const d = (ka.parts[i] ?? 0) - (kb.parts[i] ?? 0);
    if (d !== 0) return d;
  }
  // Same core: the release is above its prereleases, which then order by tag.
  if (ka.pre !== kb.pre) return ka.pre ? -1 : 1;
  return ka.tag.localeCompare(kb.tag);
}

/** The version a card offers: the highest that is not a prerelease, else the highest listed. */
export function preferredVersion(versions: readonly DshIndexVersion[]): DshIndexVersion | null {
  if (versions.length === 0) return null;
  const sorted = [...versions].sort((a, b) => compareVersions(b.version, a.version));
  return sorted.find((v) => !versionKey(v.version).pre) ?? sorted[0]!;
}

/** Flattens a checked index into the rows a page lists, one per plugin. */
export function dshEntries(index: DshIndex, source: DshSource): DshEntry[] {
  const out: DshEntry[] = [];
  for (const plugin of index.plugins) {
    const chosen = preferredVersion(plugin.versions);
    if (chosen === null) continue;
    out.push({
      name: plugin.name,
      version: chosen.version,
      // Newest first, release before its prereleases: the detail view lists them in this order,
      // and an index is not required to list its versions that way.
      versions: [...plugin.versions]
        .sort((a, b) => compareVersions(b.version, a.version))
        .map((v) => v.version),
      title: plugin.title ?? plugin.name,
      ...(plugin.description !== undefined ? { description: plugin.description } : {}),
      ...(plugin.author !== undefined ? { author: plugin.author } : {}),
      ...(plugin.homepage !== undefined ? { homepage: plugin.homepage } : {}),
      ...(plugin.repository?.url !== undefined ? { repository: plugin.repository.url } : {}),
      ...(plugin.metadata?.category !== undefined
        ? {
            category: plugin.metadata.category,
            ...(index.categories[plugin.metadata.category] !== undefined
              ? { categoryTitle: index.categories[plugin.metadata.category] }
              : {}),
          }
        : {}),
      keywords: plugin.metadata?.keywords ?? [],
      ...(chosen.engines?.dsh !== undefined ? { enginesDsh: chosen.engines.dsh } : {}),
      ...(chosen.publishTimestamp !== undefined
        ? { publishTimestamp: chosen.publishTimestamp }
        : {}),
      source: chosen.source,
      sourceId: source.id,
      sourceUrl: source.url,
    });
  }
  return out;
}

export interface DshFetchOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxBytes?: number;
}

/** The cap an index may reach: upstream's own default for the document. */
export const MAX_DSH_INDEX_BYTES = 128 * 1024 * 1024;
/**
 * Long enough for a big index over a slow link: the official market is 9.5 MB and takes about
 * 14 s from this host on a good day, so 30 s left too little room and a timeout showed the page
 * an empty list.
 */
const DEFAULT_INDEX_TIMEOUT_MS = 60_000;

/** Fetches one index document and checks it. */
export async function fetchDshIndex(
  url: string,
  options: DshFetchOptions = {},
): Promise<{ index: DshIndex; raw: string }> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeout = options.timeoutMs ?? DEFAULT_INDEX_TIMEOUT_MS;
  const max = options.maxBytes ?? MAX_DSH_INDEX_BYTES;
  let res: Response | null = null;
  let lastError: unknown = null;
  // A connection that fails or times out is tried once more: this host drops the first TLS
  // handshake to a dual-stack CDN often enough that a single attempt reads as "source down".
  for (let attempt = 1; attempt <= 2 && res === null; attempt += 1) {
    try {
      res = await fetchImpl(url, {
        headers: { "user-agent": userAgent(), accept: "application/json" },
        signal: AbortSignal.timeout(timeout),
        redirect: "follow",
      });
    } catch (err) {
      lastError = err;
      if (attempt === 1) await new Promise((done) => setTimeout(done, 1_000));
    }
  }
  if (res === null) {
    throw new Error(
      `读取索引 ${url} 失败：${lastError instanceof Error ? lastError.message : String(lastError)}`,
    );
  }
  if (!res.ok) throw new Error(`索引 ${url} 返回 HTTP ${res.status}`);
  const length = Number(res.headers.get("content-length") ?? "0");
  if (length > max) throw new Error(`索引 ${url} 超过 ${max} 字节上限`);
  const raw = await res.text();
  if (raw.length > max) throw new Error(`索引 ${url} 超过 ${max} 字节上限`);
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `索引 ${url} 不是合法 JSON：${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return { index: parseDshIndex(data, url), raw };
}

/** How long a read index is reused before the next read fetches it again. */
export const DSH_INDEX_TTL_MS = 10 * 60_000;
/** How long a failed read stands before the next read tries again. */
export const DSH_INDEX_RETRY_MS = 60_000;
/** How many sources' entry lists one process keeps: enough for a team's sources, bounded. */
const MAX_CACHED_SOURCES = 8;

export interface DshRead {
  source: DshSourceState;
  entries: DshEntry[];
}

/** `work`'s value, or null once `ms` has passed first; `work` runs on either way. */
async function within<T>(work: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  try {
    return await Promise.race([work, late]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Reads every configured source, at most once per TTL, keeping the last good document when a
 * refresh fails. A source that is slow or down shortens the listing instead of emptying it: the
 * page shows the others and names the one that failed.
 */
export class DshMarket {
  private readonly cache = new Map<
    string,
    { at: number; entries: DshEntry[] | null; title: string; error: string | null }
  >();

  constructor(
    private readonly root: string,
    private readonly options: DshFetchOptions & { now?: () => number } = {},
  ) {}

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  /**
   * One source's entries, from the cache or a fresh read.
   *
   * What is cached is the flattened entry list, not the document: the community index is 5 437
   * plugins and the parsed JSON is tens of megabytes, while the rows a page and an install need
   * are a fraction of that.
   */
  private async readOne(source: DshSource): Promise<{
    entries: DshEntry[] | null;
    title: string;
    error: string | null;
  }> {
    const hit = this.cache.get(source.url);
    const now = this.now();
    if (hit !== undefined) {
      const ttl = hit.error === null ? DSH_INDEX_TTL_MS : DSH_INDEX_RETRY_MS;
      if (now - hit.at < ttl) {
        return { entries: hit.entries, title: hit.title, error: hit.error };
      }
    }
    try {
      const { index } = await fetchDshIndex(source.url, this.options);
      const entries = dshEntries(index, source);
      const title = textEn(index.title);
      this.cache.set(source.url, { at: this.now(), entries, title, error: null });
      // A deployment has a handful of sources; past this, the least recently read one goes.
      while (this.cache.size > MAX_CACHED_SOURCES) {
        const oldest = [...this.cache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        if (oldest === undefined) break;
        this.cache.delete(oldest[0]);
      }
      if (title !== "" && title !== source.title) {
        await rememberSourceTitle(this.root, source.id, title);
      }
      return { entries, title, error: null };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // A previous good document keeps being served; the failure is reported beside it.
      this.cache.set(source.url, {
        at: this.now(),
        entries: hit?.entries ?? null,
        title: hit?.title ?? "",
        error: message,
      });
      return { entries: hit?.entries ?? null, title: hit?.title ?? "", error: message };
    }
  }

  /**
   * Every source and its entries, in the order the operator added them.
   *
   * With `waitMs`, a source that has not answered by then is reported as pending instead of
   * being waited for: the page can show what did answer, and the read finishes behind it and
   * fills the cache, so the next listing has it. Without it (the default) every source is
   * awaited — the install path needs the whole set before it resolves a name.
   */
  async list({ waitMs }: { waitMs?: number } = {}): Promise<DshRead[]> {
    const sources = await readDshSources(this.root);
    const reads = await Promise.all(
      sources.map(async (source) => {
        const read = this.readOne(source);
        if (waitMs === undefined) return { answer: await read, pending: false };
        const answer = await within(read, waitMs);
        return answer === null ? { answer: null, pending: true } : { answer, pending: false };
      }),
    );
    return reads.map(({ answer: read, pending }, at) => {
      const source = sources[at]!;
      const entries = read?.entries ?? [];
      return {
        entries,
        source: {
          ...source,
          // The title an index gives itself is only known after a read; the stored one catches
          // up behind it, and this answer already shows what the document says.
          ...(read !== null && read.title !== "" ? { title: read.title } : {}),
          plugins: entries.length,
          ...(read?.error != null ? { error: read.error } : {}),
          ...(pending ? { pending: true } : {}),
        },
      };
    });
  }

  /** One entry by package name (and version), across every source; the first source wins. */
  async find(name: string, version?: string): Promise<DshEntry | null> {
    for (const read of await this.list()) {
      for (const entry of read.entries) {
        if (entry.name !== name) continue;
        if (version === undefined || entry.version === version) return entry;
      }
    }
    return null;
  }
}

/** Every entry of every source, flattened (the page's list). */
export function allEntries(reads: readonly DshRead[]): DshEntry[] {
  return reads.flatMap((r) => r.entries);
}
