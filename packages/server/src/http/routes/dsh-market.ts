/**
 * The DeepSeek Harness plugin market: the indexes an operator added, what they list, and the
 * one write that installs from them.
 *
 *   GET    /                     the sources (with what reading each gave) and every entry (any user)
 *   POST   /sources { url }      add an index source (admin) → the same listing
 *   DELETE /sources/:id          remove one source (admin) → the same listing
 *   POST   /install { name,      fetch the listed version's npm tarball, turn the part of it this
 *            version? }          server can run into a PenguinHarness plugin package, install it (admin)
 *
 * WHY A SEPARATE LISTING. A dsh plugin is a Cordis plugin that runs inside the dsh host; this
 * server has none, so an entry here is never installed as-is — it is adapted (`plugin/dsh-adapt.ts`)
 * into skills and MCP servers first. Keeping these entries out of `GET /api/plugins/registry` is
 * deliberate: that listing is what the Plugins page installs server modules from, and handing it a
 * dsh package would npm-install host code into this process.
 *
 * The tarball is fetched here, not by npm: what installs is the package this route built, so a
 * package the adapter could carry nothing from is refused before anything runs.
 */
import { Hono } from "hono";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { Bind, Component, Use } from "@prismshadow/penguin-core/kernel";
import { HttpError } from "../../http/errors.js";
import type { Config } from "../../hmr/capabilities.js";
import type { AppEnv } from "../../auth/middleware.js";
import type {
  DshMarketInstallJob,
  DshMarketInstallResponse,
  DshText,
  DshMarketResponse,
  DshSourceItem,
} from "../../api/types.js";
import { adaptDshPackage, DshNotMappableError, portedPackageName } from "../../plugin/dsh-adapt.js";
import { DshFetchError, fetchDshPackage } from "../../plugin/dsh-fetch.js";
import type { DshAdaptation } from "../../plugin/dsh-adapt.js";
import {
  DshMarket,
  addDshSource,
  allEntries,
  removeDshSource,
  textEn,
  textZh,
} from "../../plugin/dsh-market.js";
import type { DshEntry } from "../../plugin/dsh-market.js";
import {
  installPluginFiles,
  pluginsPrefix,
  readInstalledVersion,
  removePluginPackage,
} from "../../plugin/install.js";

/**
 * How long a listing waits for one index source before answering without it.
 *
 * Short on purpose: the page is opened far more often than a source is added, and one index that
 * is slow or down must not make every click on this page look dead. A source that misses this is
 * reported as pending, its read finishes behind the answer, and the page asks again until none is.
 * The install path does not use it — resolving a name needs the whole set.
 */
const SOURCE_WAIT_MS = 800;
/** How many entries one answer carries unless the caller asks for another slice. */
const DEFAULT_PAGE = 60;
/** The most one answer carries: a page's worth is a handful of screens. */
const MAX_PAGE = 200;

/** The npm scope every package this page installs lives under. */
const PORTED_SCOPE = "@dsh-ported/";

export interface DshMarketRoutesDeps {
  /** The data root: `<root>/dsh-market.json` holds the sources, `<root>/plugins` the installs. */
  root: string;
  /** Stands in for the network in tests. */
  fetchImpl?: typeof fetch;
}

/** Adding a source and installing a package write on this server: an admin's to do. */
function requireAdmin(c: { var: AppEnv["Variables"] }): void {
  if (!c.var.user.isAdmin) {
    throw new HttpError(403, "admin_required", "只有管理员可以修改插件源或安装插件。");
  }
}

/** The fetch result's source, in the shape the report carries. */
function sourceOf(source: { type: "npm" | "git"; commit?: string; path?: string }): {
  kind: "npm" | "git";
  commit?: string;
  path?: string;
} {
  return {
    kind: source.type,
    ...(source.commit === undefined ? {} : { commit: source.commit }),
    ...(source.path === undefined ? {} : { path: source.path }),
  };
}

/** The adaptation as the page shows it, in the response's own words. */
function reportOf(
  adapted: DshAdaptation,
  installed: { name: string; version: string | null },
  source: { kind: "npm" | "git"; commit?: string; path?: string },
) {
  return {
    name: installed.name,
    version: installed.version ?? adapted.report.version,
    title: adapted.report.title,
    skills: adapted.report.skills.map((s) => ({
      name: s.name,
      from: s.from,
      files: s.files,
      ...(s.needsSetup === true ? { needsSetup: true } : {}),
    })),
    mcpServers: adapted.report.mcpServers,
    mcpCarried: adapted.report.mcpCarried,
    dependencies: adapted.report.dependencies,
    source,
    dropped: adapted.report.dropped,
    warnings: adapted.report.warnings,
  };
}

/** A finished job is kept this long for a page that polls slowly; then it is forgotten. */
const JOB_RETENTION_MS = 10 * 60_000;
/** How many jobs one process remembers at once: installs are an admin's and rare. */
const MAX_JOBS = 50;

export function dshMarketRoutes(deps: DshMarketRoutesDeps): Hono<AppEnv> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const market = new DshMarket(deps.root, { fetchImpl });

  /** The installs this process is running, by id (see the POST handler). */
  const jobs = new Map<string, DshMarketInstallJob>();

  /** Turns whatever an install threw into the job's error, in the same vocabulary a refusal uses. */
  const jobError = (err: unknown): { code: string; message: string } => {
    if (err instanceof HttpError) return { code: err.code, message: err.message };
    if (err instanceof DshFetchError) return { code: err.code, message: err.message };
    if (err instanceof DshNotMappableError) {
      return { code: "dsh_not_adaptable", message: err.reasons.join("；") };
    }
    return {
      code: "dsh_install_failed",
      message: `转换或安装失败：${err instanceof Error ? err.message : String(err)}`,
    };
  };

  /** Fetches, converts and installs one entry. Slow by nature: `npm install` runs at the end. */
  const runInstall = async (entry: DshEntry): Promise<DshMarketInstallResponse> => {
    const fetched = await fetchDshPackage(entry.name, entry.version, entry.source, { fetchImpl });
    const adapted = adaptDshPackage(fetched.files, { ...entry, source: fetched.source });
    const installed = await installPluginFiles(deps.root, adapted.files);
    return reportOf(adapted, installed, sourceOf(fetched.source));
  };

  /** Starts the work and answers the job at once; the page polls its state. */
  const startInstall = (entry: DshEntry): DshMarketInstallJob => {
    const job: DshMarketInstallJob = {
      id: randomUUID(),
      name: entry.name,
      version: entry.version,
      state: "running",
      startedAt: Date.now(),
    };
    jobs.set(job.id, job);
    void (async () => {
      try {
        job.result = await runInstall(entry);
        job.state = "done";
      } catch (err) {
        job.error = jobError(err);
        job.state = "failed";
      }
      // Old finished jobs go first: a page that never polls again must not grow this map.
      const finished = [...jobs.values()].filter((j) => j.state !== "running");
      for (const old of finished) {
        if (Date.now() - old.startedAt > JOB_RETENTION_MS) jobs.delete(old.id);
      }
      while (jobs.size > MAX_JOBS) {
        // Only finished jobs are dropped: the running ones are what the page is polling for.
        const oldest = [...jobs.values()]
          .filter((j) => j.state !== "running")
          .sort((a, b) => a.startedAt - b.startedAt)[0];
        if (oldest === undefined) break;
        jobs.delete(oldest.id);
      }
    })();
    return job;
  };

  /**
   * What this server already holds of the ported packages, by package name.
   *
   * A card says "installed" from this rather than from a click's own memory: the page may be
   * opened long after the install, on another browser, or after someone removed it by CLI.
   */
  const installedPorted = async (): Promise<Map<string, string | null>> => {
    const out = new Map<string, string | null>();
    const prefix = pluginsPrefix(deps.root);
    let dependencies: Record<string, unknown>;
    try {
      const manifest = JSON.parse(await fs.readFile(path.join(prefix, "package.json"), "utf8")) as {
        dependencies?: Record<string, unknown>;
      };
      dependencies = manifest.dependencies ?? {};
    } catch {
      return out;
    }
    for (const name of Object.keys(dependencies)) {
      if (!name.startsWith(PORTED_SCOPE)) continue;
      out.set(name, await readInstalledVersion(prefix, name));
    }
    return out;
  };

  /**
   * One page of the market.
   *
   * The whole set is thousands of plugins — the official index alone is 12 576 rows, ~9 MB as
   * JSON — so the page asks for a slice and for the text it is looking for, and the filtering
   * happens here, over entries that are already cached. `total` is what matched, so the page can
   * say "12 / 12 576" without holding the rest in memory.
   */
  const listing = async (
    opts: { q?: string; category?: string; limit?: number; offset?: number } = {},
  ): Promise<DshMarketResponse> => {
    const reads = await market.list({ waitMs: SOURCE_WAIT_MS });
    const installed = await installedPorted();
    const sources: DshSourceItem[] = reads.map((read) => ({
      id: read.source.id,
      url: read.source.url,
      title: read.source.title,
      plugins: read.source.plugins,
      ...(read.source.error !== undefined ? { error: read.source.error } : {}),
      ...(read.source.pending === true ? { pending: true } : {}),
    }));
    const needle = (opts.q ?? "").trim().toLowerCase();
    const all = allEntries(reads);
    const searched =
      needle === ""
        ? all
        : all.filter((entry) =>
            [
              entry.name,
              textEn(entry.title),
              textZh(entry.title),
              textEn(entry.description),
              textZh(entry.description),
              ...entry.keywords,
            ]
              .join(" ")
              .toLowerCase()
              .includes(needle),
          );
    // The chips count what the search matched, so narrowing by text keeps the row meaningful;
    // the category filter itself is applied after, to the list only.
    const counts = new Map<string, { title?: DshText; count: number }>();
    for (const entry of searched) {
      const id = entry.category ?? "";
      const bucket = counts.get(id) ?? {
        ...(entry.categoryTitle === undefined ? {} : { title: entry.categoryTitle }),
        count: 0,
      };
      bucket.count += 1;
      counts.set(id, bucket);
    }
    const categories = [...counts.entries()]
      .map(([id, bucket]) => ({
        id,
        count: bucket.count,
        ...(bucket.title === undefined ? {} : { title: bucket.title }),
      }))
      .sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));
    const matched =
      opts.category === undefined
        ? searched
        : searched.filter((entry) => (entry.category ?? "") === opts.category);
    const offset = Math.max(0, opts.offset ?? 0);
    const limit = Math.min(MAX_PAGE, Math.max(1, opts.limit ?? DEFAULT_PAGE));
    return {
      sources,
      categories,
      total: matched.length,
      entries: matched.slice(offset, offset + limit).map((entry) => {
        const held = installed.get(portedPackageName(entry.name));
        return held == null ? entry : { ...entry, installedVersion: held };
      }),
    };
  };

  const app = new Hono<AppEnv>();

  app.get("/", async (c) =>
    c.json(
      await listing({
        q: c.req.query("q"),
        category: c.req.query("category"),
        limit: Number(c.req.query("limit") ?? DEFAULT_PAGE),
        offset: Number(c.req.query("offset") ?? 0),
      }),
    ),
  );

  app.post("/sources", async (c) => {
    requireAdmin(c);
    const body = (await c.req.json().catch(() => null)) as { url?: unknown } | null;
    const url = typeof body?.url === "string" ? body.url.trim() : "";
    if (url === "") throw new HttpError(400, "bad_request", "需要索引文件地址");
    try {
      await addDshSource(deps.root, url);
    } catch (err) {
      throw new HttpError(
        400,
        "dsh_source_invalid",
        err instanceof Error ? err.message : String(err),
      );
    }
    return c.json(await listing());
  });

  app.delete("/sources/:id", async (c) => {
    requireAdmin(c);
    const removed = await removeDshSource(deps.root, c.req.param("id"));
    if (!removed) throw new HttpError(404, "not_found", "没有这个索引源");
    return c.json(await listing());
  });

  /**
   * An install is a job, not a request: fetching a tarball and running `npm install` takes tens of
   * seconds — longer than the Web App's socket waits for an answer — so the POST answers with an
   * id (202) and the page polls the route below. What is converted does not change; only the
   * shape of the call does.
   */
  app.post("/install", async (c) => {
    requireAdmin(c);
    const body = (await c.req.json().catch(() => null)) as {
      name?: unknown;
      version?: unknown;
    } | null;
    const name = typeof body?.name === "string" ? body.name : "";
    const version = typeof body?.version === "string" ? body.version : undefined;
    if (name === "") throw new HttpError(400, "bad_request", "需要插件名");
    const entry = await market.find(name, version);
    if (entry === null) {
      throw new HttpError(
        404,
        "dsh_entry_missing",
        `索引里没有 ${name}${version ? `@${version}` : ""}`,
      );
    }
    return c.json(startInstall(entry), 202);
  });

  /** One job's state; the page polls this until it is "done" or "failed". */
  app.get("/install/:id", async (c) => {
    const job = jobs.get(c.req.param("id"));
    if (job === undefined)
      throw new HttpError(404, "not_found", "没有这个安装任务（服务器可能重启过）");
    return c.json(job);
  });

  /**
   * Removes a ported package from this server. Only `@dsh-ported/*` — the packages this page
   * installs — so a stray name cannot take another plugin off the server.
   */
  app.post("/uninstall", async (c) => {
    requireAdmin(c);
    const body = (await c.req.json().catch(() => null)) as { name?: unknown } | null;
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    if (!/^@dsh-ported\/[A-Za-z0-9_-]+$/.test(name)) {
      throw new HttpError(400, "bad_request", "只能卸载本页转换安装的插件（@dsh-ported/…）。");
    }
    const version = await readInstalledVersion(pluginsPrefix(deps.root), name);
    if (version === null) throw new HttpError(404, "dsh_not_installed", `${name} 不在这台服务器上`);
    await removePluginPackage(deps.root, name);
    return c.json(await listing());
  });

  return app;
}

/**
 * The routes above, wired as one module on the App. Any logged-in user reads the market (it is a
 * listing, like the Plugins page's own registry); adding a source and installing a package are an
 * admin's, because an install writes into this server's plugin prefix.
 */
@Component({
  contributes: {
    "HttpModule.routes": [
      {
        id: "DshMarketRoutes.routes",
        prefix: "/api/plugins/dsh-market",
        auth: "user",
        order: 70,
      },
    ],
  },
})
export class DshMarketRoutes {
  @Use() private readonly config!: Config;
  @Bind("DshMarketRoutes.routes") routes!: Hono<AppEnv>;
  setup() {
    this.routes = dshMarketRoutes({ root: this.config.root });
  }
}
