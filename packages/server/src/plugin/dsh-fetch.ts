/**
 * Getting one dsh plugin's files, whichever way the index publishes it.
 *
 * An index pins every version to a source: an npm package, or a git repository at an exact
 * commit with a directory inside it (monorepos are common — the official market publishes 60% of
 * its plugins that way). Both end at the same place: a `relative path → bytes` map the adapter
 * can read, exactly what an npm tarball's `package/` holds.
 *
 * Everything here is bounded: the download, the unpacked tree, the file count and what is read
 * into memory. A plugin market is third-party input, and a tarball that unpacks to fill a disk is
 * the ordinary failure mode of trusting it.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import * as tar from "tar";
import type { DshVersionSource } from "../api/types.js";

/**
 * The largest archive fetched for one plugin.
 *
 * A repository archive is nothing like a package tarball: it carries the whole history-free tree
 * — docs, screenshots, fixtures, sometimes a vendored dependency — and 60% of the market is
 * published that way. What actually reaches the ported package is still bounded by the file and
 * memory caps below, so this only decides how much temp disk one download may take.
 */
const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;
/** The most an archive may unpack to: a gzip bomb must not fill the disk a download sits on. */
const MAX_UNPACKED_BYTES = 512 * 1024 * 1024;
/** The largest one extracted file may be, matching a plugin zip's per-file cap. */
const MAX_FILE_BYTES = 5 * 1024 * 1024;
/** How many files one package may hold, matching the zip cap. */
const MAX_FILES = 5000;
/** What the package may weigh once read into memory: skills and manifests, not assets. */
const MAX_READ_BYTES = 64 * 1024 * 1024;
/** npm's metadata request may take a while; this is the same budget an install gets. */
const NPM_TIMEOUT_MS = 60_000;
/** A repository archive is bigger than a package tarball and served from a slower host. */
const GIT_TIMEOUT_MS = 120_000;

export class DshFetchError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "DshFetchError";
  }
}

/** A package's files, and where they came from (recorded in the ported package). */
export interface FetchedDshPackage {
  files: Map<string, Uint8Array>;
  source: { type: "npm" | "git"; url?: string; commit?: string; path?: string };
}

/** One request with the retries a flaky network needs (see the market routes' own note). */
async function fetchWithRetries(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  attempts = 3,
): Promise<Response> {
  let last: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fetchImpl(url, init);
    } catch (err) {
      last = err;
      if (attempt < attempts) {
        await new Promise((done) => setTimeout(done, 500 * 2 ** (attempt - 1)));
      }
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

/** `{tarball, integrity}` for one published npm version. */
async function npmTarball(
  name: string,
  version: string,
  registry: string | undefined,
  fetchImpl: typeof fetch,
): Promise<{ url: string }> {
  const base = (registry ?? "https://registry.npmjs.org").replace(/\/$/, "");
  const metaUrl = `${base}/${name.replace("/", "%2F")}`;
  let res: Response;
  try {
    res = await fetchWithRetries(fetchImpl, metaUrl, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(NPM_TIMEOUT_MS),
    });
  } catch (err) {
    throw new DshFetchError(
      "dsh_registry_unreachable",
      `npm 元数据读取失败（已重试 3 次）：${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!res.ok) {
    throw new DshFetchError("dsh_registry_unreachable", `npm 返回 HTTP ${res.status}`);
  }
  const meta = (await res.json()) as {
    versions?: Record<string, { dist?: { tarball?: unknown } }>;
  };
  const tarball = meta.versions?.[version]?.dist?.tarball;
  if (typeof tarball !== "string") {
    throw new DshFetchError("dsh_version_missing", `npm 上没有 ${name}@${version}`);
  }
  return { url: tarball };
}

/**
 * Where to download one repository at one commit, as a tarball.
 *
 * GitHub and GitLab have stable archive URLs; anything else gets the most common shape and is
 * reported plainly when it does not answer. A branch or tag is never used: the index pins a
 * commit, and installing what a branch happens to point at today is not what the confirmation
 * promised.
 */
export function gitArchiveUrl(source: { url?: string; commit?: string }): string {
  const raw = (source.url ?? "").trim();
  if (raw === "") {
    throw new DshFetchError("dsh_source_invalid", "这个 git 版本没有给仓库地址");
  }
  const commit = (source.commit ?? "").trim();
  if (commit === "") {
    throw new DshFetchError("dsh_source_invalid", "这个 git 版本没有锁定 commit，拒绝安装");
  }
  let url: URL;
  try {
    url = new URL(raw.endsWith(".git") ? raw.slice(0, -4) : raw);
  } catch {
    throw new DshFetchError("dsh_source_invalid", `不是可用的仓库地址：${raw}`);
  }
  const segments = url.pathname
    .replace(/^\/+|\/+$/g, "")
    .split("/")
    .filter(Boolean);
  if (segments.length < 2) {
    throw new DshFetchError("dsh_source_invalid", `仓库地址缺少属主或仓库名：${raw}`);
  }
  const repo = segments[segments.length - 1]!;
  if (url.hostname === "github.com" || url.hostname === "www.github.com") {
    const owner = segments[segments.length - 2]!;
    return `https://codeload.github.com/${owner}/${repo}/tar.gz/${commit}`;
  }
  if (url.hostname.includes("gitlab")) {
    const project = segments.join("/");
    return `https://${url.hostname}/${project}/-/archive/${commit}/${repo}-${commit}.tar.gz`;
  }
  return `https://${url.hostname}/${segments.join("/")}/archive/${commit}.tar.gz`;
}

/** Downloads one archive into a temp file, refusing what exceeds the cap while it streams. */
async function download(
  url: string,
  fetchImpl: typeof fetch,
  dir: string,
  timeoutMs: number,
): Promise<string> {
  let res: Response;
  try {
    res = await fetchWithRetries(fetchImpl, url, {
      headers: { accept: "application/octet-stream" },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new DshFetchError(
      "dsh_download_failed",
      `插件包下载失败（已重试 3 次）：${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!res.ok) {
    throw new DshFetchError("dsh_download_failed", `插件包下载返回 HTTP ${res.status}`);
  }
  const length = Number(res.headers.get("content-length") ?? "0");
  if (length > MAX_ARCHIVE_BYTES) {
    throw new DshFetchError("dsh_package_too_large", "插件包超过 64 MB 上限");
  }
  const body = res.body;
  if (body === null) throw new DshFetchError("dsh_download_failed", "插件包没有内容");
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    total += chunk.byteLength;
    if (total > MAX_ARCHIVE_BYTES) {
      throw new DshFetchError("dsh_package_too_large", "插件包超过 64 MB 上限");
    }
    chunks.push(chunk);
  }
  const file = path.join(dir, `${randomUUID()}.tgz`);
  await fs.writeFile(file, Buffer.concat(chunks));
  return file;
}

/** Reads an unpacked directory into `relative POSIX path → bytes`. */
async function readTree(dir: string): Promise<Map<string, Uint8Array>> {
  const out = new Map<string, Uint8Array>();
  let total = 0;
  const walk = async (current: string, base: string): Promise<void> => {
    for (const item of await fs.readdir(current, { withFileTypes: true })) {
      const rel = base === "" ? item.name : `${base}/${item.name}`;
      const abs = path.join(current, item.name);
      if (item.isSymbolicLink()) continue;
      if (item.isDirectory()) {
        await walk(abs, rel);
        continue;
      }
      if (!item.isFile()) continue;
      const stat = await fs.stat(abs);
      if (stat.size > MAX_FILE_BYTES) continue;
      if (out.size >= MAX_FILES) {
        throw new DshFetchError("dsh_package_too_large", `插件包文件数超过 ${MAX_FILES}`);
      }
      total += stat.size;
      if (total > MAX_READ_BYTES) {
        throw new DshFetchError("dsh_package_too_large", "插件包读取内容超过 64 MB 上限");
      }
      out.set(rel, new Uint8Array(await fs.readFile(abs)));
    }
  };
  await walk(dir, "");
  return out;
}

/**
 * Extracts an archive and reads one directory out of it.
 *
 * `subdir` is a repository's inner path (a monorepo package). Empty means "the archive's single
 * top directory", which is what both npm tarballs (`package/`) and GitHub archives
 * (`<repo>-<sha>/`) look like.
 */
export async function unpackArchive(
  archive: string,
  subdir: string,
): Promise<Map<string, Uint8Array>> {
  // Sizes are read from the archive's own member list before a byte is written: a bomb is
  // refused whole instead of filling the disk first.
  let unpacked = 0;
  let members = 0;
  await tar.t({
    file: archive,
    gzip: true,
    onReadEntry: (entry) => {
      unpacked += entry.size ?? 0;
      members += 1;
      entry.resume();
    },
  });
  if (unpacked > MAX_UNPACKED_BYTES) {
    throw new DshFetchError("dsh_package_too_large", "插件包解压后超过 256 MB 上限");
  }
  if (members > MAX_FILES * 4) {
    throw new DshFetchError("dsh_package_too_large", "插件包条目数异常");
  }

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dsh-unpack-"));
  try {
    // A monorepo package names its directory: extract that subtree only, so the rest of the
    // repository never touches the disk.
    const keep = (entryPath: string): boolean => {
      if (subdir === "") return true;
      const parts = entryPath.replace(/^\/+/, "").split("/");
      if (parts.length < 2) return true;
      const inner = parts.slice(1).join("/");
      return inner === subdir || inner.startsWith(`${subdir}/`);
    };
    await tar.x({ file: archive, cwd: dir, gzip: true, preservePaths: false, filter: keep });
    // Every archive of a repository (and every npm tarball) nests its tree under one directory:
    // `<repo>-<sha>/` or `package/`. A monorepo package lives inside that, not beside it.
    const tops = (await fs.readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory());
    const base = tops.length === 1 ? path.join(dir, tops[0]!.name) : dir;
    const root = subdir === "" ? base : path.join(base, ...subdir.split("/").filter(Boolean));
    const inside = path.relative(dir, root);
    if (inside.startsWith("..") || path.isAbsolute(inside)) {
      throw new DshFetchError("dsh_source_invalid", `目录 ${subdir} 不在这个仓库里`);
    }
    const stat = await fs.stat(root).catch(() => null);
    if (stat === null || !stat.isDirectory()) {
      throw new DshFetchError("dsh_source_invalid", `仓库里没有目录 ${subdir || "(根)"}`);
    }
    return await readTree(root);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/**
 * One listed version's files, from npm or from a repository at its pinned commit.
 *
 * The caller gets the same shape either way, so the adapter never learns where a package came
 * from; the returned `source` is what the ported package records.
 */
export async function fetchDshPackage(
  name: string,
  version: string,
  source: DshVersionSource,
  options: { fetchImpl?: typeof fetch } = {},
): Promise<FetchedDshPackage> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dsh-fetch-"));
  try {
    if (source.type === "npm") {
      const { url } = await npmTarball(name, version, source.registry, fetchImpl);
      const archive = await download(url, fetchImpl, dir, NPM_TIMEOUT_MS);
      return { files: await unpackArchive(archive, ""), source: { type: "npm" } };
    }
    const archive = await download(gitArchiveUrl(source), fetchImpl, dir, GIT_TIMEOUT_MS);
    const subdir = (source.path ?? "").replace(/^\/+|\/+$/g, "");
    return {
      files: await unpackArchive(archive, subdir),
      source: {
        type: "git",
        ...(source.url === undefined ? {} : { url: source.url }),
        ...(source.commit === undefined ? {} : { commit: source.commit }),
        ...(source.path === undefined ? {} : { path: source.path }),
      },
    };
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
