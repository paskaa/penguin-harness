/**
 * Turns a DeepSeek Harness plugin package into a PenguinHarness plugin package.
 *
 * A dsh plugin is a Cordis plugin: it exports `apply(ctx)` and runs inside the dsh host, with
 * peer dependencies on `@deepseek-ai/dsh-*`. This server has no such host, so its code cannot be
 * carried over — what CAN be carried is the part of a package that already means the same thing
 * on both sides:
 *
 *   - `skills/<name>/SKILL.md` (anywhere in the package: dsh plugins nest them, e.g.
 *     `data/experts/<division>/<expert>/skills/<skill>/SKILL.md`) — a Penguin skill is the same
 *     directory with the same three-key frontmatter;
 *   - MCP servers the package declares (`.mcp.json`, `package.json.mcpServers`) — a Penguin
 *     package declares them in `penguin.mcp_servers` and an install writes them into the Agent.
 *
 * Everything else — `index.js`, `client.js`, `cordis.patch.yml`, the client injection list — has
 * no Penguin equivalent and is dropped, named in the report rather than silently lost.
 *
 * A package with neither skills nor MCP servers is not adaptable: it is refused with the reasons
 * (see DshNotMappableError) instead of installing something that would do nothing.
 */
import {
  PLUGIN_NAME_PATTERN,
  carriesBinary,
  isSafeIconSvg,
  parseSkillFrontmatter,
} from "@prismshadow/penguin-core";
import type { DshEntry } from "./dsh-market.js";
import { textEn, textZh } from "./dsh-market.js";

/** The largest a single file of a ported package may be: the same cap a plugin zip has. */
const MAX_FILE_BYTES = 5 * 1024 * 1024;
/** A ported package's total budget: skills and icons, not a build output. */
const MAX_TOTAL_BYTES = 50 * 1024 * 1024;

/** Extensions a skill may carry: text, because a Penguin skill is installed as text files. */
const TEXT_EXTENSIONS = new Set([
  ".md",
  ".txt",
  ".json",
  ".jsonc",
  ".yaml",
  ".yml",
  ".toml",
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
  ".py",
  ".sh",
  ".bash",
  ".zsh",
  ".ps1",
  ".csv",
  ".tsv",
  ".xml",
  ".html",
  ".css",
  ".sql",
  ".svg",
  ".ini",
  ".cfg",
  ".conf",
  ".example",
  ".env",
  ".gitignore",
  ".dockerfile",
]);

/** A dsh package with nothing this server can carry. */
export class DshNotMappableError extends Error {
  constructor(
    readonly reasons: string[],
    message = reasons.join("；"),
  ) {
    super(message);
    this.name = "DshNotMappableError";
  }
}

/** What the adaptation produced. */
export interface DshAdaptation {
  /** The Penguin package's files, relative POSIX path → bytes (package.json included). */
  files: Map<string, Uint8Array>;
  report: {
    /** The package name installed (scoped, so it cannot shadow a dsh package of the same name). */
    name: string;
    version: string;
    title: string;
    skills: {
      name: string;
      from: string;
      files: number;
      /** The skill's own package declares runtime dependencies: it needs `npm install` first. */
      needsSetup?: boolean;
    }[];
    mcpServers: string[];
    /** MCP servers whose own files travelled with them (a stdio server's script and helpers). */
    mcpCarried: { server: string; files: number }[];
    /** Runtime dependencies carried into the ported package.json (installed by npm on install). */
    dependencies: string[];
    dropped: { path: string; reason: string }[];
    warnings: string[];
  };
}

const decoder = new TextDecoder("utf-8");
const encoder = new TextEncoder();

function isText(path: string): boolean {
  const dot = path.lastIndexOf(".");
  if (dot < 0) {
    // Extensionless README/LICENSE-style files are text; anything else is not carried.
    return /(^|\/)(LICENSE|NOTICE|AUTHORS|COPYING)$/i.test(path);
  }
  return TEXT_EXTENSIONS.has(path.slice(dot).toLowerCase());
}

/** A name that satisfies Penguin's plugin/skill pattern. */
function safeName(raw: string, fallback: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9_-]/g, "-").replace(/^-+|-+$/g, "");
  return PLUGIN_NAME_PATTERN.test(cleaned) ? cleaned : fallback;
}

/** The npm name a ported package is installed under: scoped so it never shadows the dsh package. */
export function portedPackageName(dshName: string): string {
  const base = dshName.includes("/") ? dshName.slice(dshName.lastIndexOf("/") + 1) : dshName;
  return `@dsh-ported/${safeName(base, "plugin")}`;
}

/** A one-line description from a skill body: the first paragraph that is not a heading or a fence. */
function descriptionFrom(body: string): string {
  for (const block of body.split(/\n{2,}/)) {
    const line = block
      .replace(/^#{1,6}\s+.*$/gm, "")
      .replace(/```[\s\S]*?```/g, "")
      .replace(/[*_`>]/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (line !== "") return line.length > 200 ? `${line.slice(0, 197)}…` : line;
  }
  return "";
}

/** One line as a YAML scalar that reads back unchanged; control characters are flattened. */
function quoteScalar(value: string): string {
  return JSON.stringify(value.replace(/[\u0000-\u001f\u007f]+/g, " "));
}

/** Today's date in Penguin's skill-version form: `YYYY.MM.DD.1`. */
function skillVersion(now: Date): string {
  const iso = now.toISOString().slice(0, 10).replace(/-/g, ".");
  return `${iso}.1`;
}

/**
 * Rewrites a SKILL.md to the three keys Penguin's parser reads, keeping its body verbatim.
 *
 * `name` is the directory the skill is written to — never the upstream frontmatter's name, which
 * may be the one a second skill of the same package already took. A skill whose frontmatter and
 * directory disagree is what the loader refuses to install cleanly.
 */
function normalizeSkill(
  content: string,
  name: string,
  now: Date,
): { text: string; description: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content);
  const body = match === null ? content : content.slice(match[0].length);
  const parsed = parseSkillFrontmatter(content);
  const description =
    (parsed?.description ?? "").trim() || descriptionFrom(body) || `${name} skill`;
  const oneLine = description.replace(/\s+/g, " ");
  // The description is always written as a double-quoted scalar (JSON's escaping is valid YAML):
  // a plain one would be misread wherever it holds `: `, starts with `-`, `#` or `[`, or ends
  // with `:`. The reader that installed copies use gets the same string back either way.
  const frontmatter = [
    "---",
    `name: ${name}`,
    `description: ${quoteScalar(oneLine)}`,
    `version: ${skillVersion(now)}`,
    "---",
  ].join("\n");
  return { text: `${frontmatter}\n\n${body.replace(/^\s*\n/, "")}`, description: oneLine };
}

/** One skill found in the package. */
interface FoundSkill {
  name: string;
  dir: string;
  skillFile: string;
}

/**
 * Every skill directory of the package: a `SKILL.md` whose parent sits under a `skills/`
 * directory, anywhere in the tree, plus a `SKILL.md` at the package root (a single-skill pack).
 */
function findSkills(paths: readonly string[]): FoundSkill[] {
  const found: FoundSkill[] = [];
  const seen = new Set<string>();
  for (const path of paths) {
    if (!/(^|\/)SKILL\.md$/.test(path)) continue;
    const dir = path.slice(0, path.lastIndexOf("/"));
    const nested = /(^|\/)skills\/[^/]+$/.test(dir);
    const root = dir === "" || dir === ".";
    if (!nested && !root) continue;
    const base = root ? "skill" : dir.slice(dir.lastIndexOf("/") + 1);
    let name = safeName(base, "skill");
    if (seen.has(name)) name = safeName(`${dir.split("/").slice(-2).join("-")}`, `${name}-2`);
    let unique = name;
    for (let i = 2; seen.has(unique); i += 1) unique = `${name}-${i}`;
    seen.add(unique);
    found.push({ name: unique, dir: root ? "" : dir, skillFile: path });
  }
  return found;
}

/**
 * The files a stdio MCP server needs beside its config.
 *
 * A declared server is usually `command: node, args: ["./server.js"]`, and that script is inside
 * the package: without it the entry installs and can never start. Its whole directory travels
 * (a server is rarely one file — helpers, a package.json), the config is rewritten to
 * `${PLUGIN_ROOT}/mcp/<server>/…`, and the sizes stay bounded like everything else here.
 */
function mcpServerFiles(
  files: ReadonlyMap<string, Uint8Array>,
  server: { name: string; config: Record<string, unknown> },
): { added: Map<string, Uint8Array>; config: Record<string, unknown> } | null {
  const config = server.config;
  if (config.transport !== "stdio") return null;
  const added = new Map<string, Uint8Array>();
  let total = 0;
  const carry = (rel: string): void => {
    const dir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
    const prefix = dir === "" ? "" : `${dir}/`;
    for (const [path, bytes] of files) {
      // A server's own directory travels with it; an entrypoint at the package root means the
      // package root IS its directory, so everything but the port's own files goes along.
      if (prefix !== "" && !path.startsWith(prefix)) continue;
      if (path.includes("node_modules/")) continue;
      if (SKIP_WITH_MCP.has(path) || path.startsWith("skills/")) continue;
      if (bytes.byteLength > MAX_FILE_BYTES) continue;
      total += bytes.byteLength;
      if (total > MAX_TOTAL_BYTES) return;
      added.set(path, bytes);
    }
  };

  // (a) The server already speaks this harness's own convention: `${PLUGIN_ROOT}/server/index.js`.
  // Its files are copied to the same relative paths, so the config needs no rewriting at all.
  const rooted: string[] = [];
  for (const text of JSON.stringify(config).match(/"\$\{PLUGIN_ROOT\}\/([^"]+)"/g) ?? []) {
    rooted.push(text.replace(/^"\$\{PLUGIN_ROOT\}\//, "").replace(/"$/, ""));
  }
  for (const rel of rooted) {
    if (files.has(rel)) carry(rel);
  }
  if (added.size > 0) return { added, config };

  // (b) A plain relative entrypoint (`args: ["./server.js"]`): its directory travels under
  // `mcp/<server>/`, and the argument is rewritten to point there.
  const args = Array.isArray(config.args)
    ? config.args.filter((a): a is string => typeof a === "string")
    : [];
  const entry = args.find((arg) => !arg.startsWith("-") && files.has(normalizeRel(arg)));
  if (entry === undefined) return null;
  const entryPath = normalizeRel(entry);
  carry(entryPath);
  if (added.size === 0) return null;
  const root = `mcp/${server.name}`;
  const moved = new Map<string, Uint8Array>();
  for (const [path, bytes] of added) moved.set(`${root}/${path}`, bytes);
  return {
    added: moved,
    config: {
      ...config,
      args: args.map((arg) => (arg === entry ? `${"${PLUGIN_ROOT}"}/${root}/${entryPath}` : arg)),
    },
  };
}

/** Files at a package root that belong to the port, not to a server copying its directory. */
const SKIP_WITH_MCP = new Set([
  "package.json",
  "package-lock.json",
  ".mcp.json",
  "mcp.json",
  "README.md",
  "icon.svg",
  "cordis.patch.yml",
]);

/** A package-relative path with its leading `./` and slashes normalized. */
function normalizeRel(value: string): string {
  return value.replace(/^\.\//, "").replace(/^\//, "");
}

/** MCP servers a package declares, in Claude's `mcpServers` shape. */
function readMcpServers(
  manifest: Record<string, unknown>,
  files: ReadonlyMap<string, Uint8Array>,
): { name: string; config: Record<string, unknown> }[] {
  const candidates: unknown[] = [];
  const dotMcp = files.get(".mcp.json");
  if (dotMcp !== undefined) {
    try {
      const parsed = JSON.parse(decoder.decode(dotMcp)) as { mcpServers?: unknown };
      candidates.push(parsed.mcpServers);
    } catch {
      // A broken .mcp.json declares nothing; the report does not need a separate warning.
    }
  }
  candidates.push(manifest.mcpServers);
  const dsh = manifest.dsh;
  if (typeof dsh === "object" && dsh !== null) {
    candidates.push((dsh as { mcpServers?: unknown }).mcpServers);
  }
  const out: { name: string; config: Record<string, unknown> }[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (typeof candidate !== "object" || candidate === null) continue;
    for (const [rawName, rawConfig] of Object.entries(candidate as Record<string, unknown>)) {
      if (typeof rawConfig !== "object" || rawConfig === null) continue;
      const entry = rawConfig as Record<string, unknown>;
      const name = safeName(rawName, "server");
      if (seen.has(name)) continue;
      const config = toPenguinMcpConfig(entry);
      if (config === null) continue;
      seen.add(name);
      out.push({ name, config });
    }
  }
  return out;
}

/** One `mcpServers` entry as Penguin's own config spells it; null when it names no transport. */
function toPenguinMcpConfig(entry: Record<string, unknown>): Record<string, unknown> | null {
  const type = typeof entry.type === "string" ? entry.type : undefined;
  if (type === "http" || type === "sse") {
    if (typeof entry.url !== "string") return null;
    return {
      transport: type,
      url: entry.url,
      ...(typeof entry.headers === "object" && entry.headers !== null
        ? { headers: entry.headers }
        : {}),
    };
  }
  if (typeof entry.url === "string") {
    return {
      transport: "http",
      url: entry.url,
      ...(typeof entry.headers === "object" && entry.headers !== null
        ? { headers: entry.headers }
        : {}),
    };
  }
  if (typeof entry.command === "string") {
    return {
      transport: "stdio",
      command: entry.command,
      ...(Array.isArray(entry.args)
        ? { args: entry.args.filter((a) => typeof a === "string") }
        : {}),
      ...(typeof entry.env === "object" && entry.env !== null ? { env: entry.env } : {}),
      ...(typeof entry.cwd === "string" ? { cwd: entry.cwd } : {}),
    };
  }
  return null;
}

/** `${KEY}` references a config makes, in order, deduplicated. */
function setupKeys(config: unknown): string[] {
  const text = JSON.stringify(config) ?? "";
  const keys: string[] = [];
  for (const match of text.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) {
    const key = match[1]!;
    if (!keys.includes(key)) keys.push(key);
  }
  return keys;
}

/** The dsh category → Penguin category, where one obviously maps; otherwise omitted ("Other"). */
function penguinCategory(category: string | undefined): string | undefined {
  switch (category) {
    case "workflow":
    case "automation":
      return "office-productivity";
    case "development":
    case "git":
    case "code-review":
      return "software-development";
    case "memory":
    case "models":
    case "tools":
      return "ai-app-development";
    default:
      return undefined;
  }
}

/** A quick start prompt for the card: what the operator would ask first. */
function quickStartPrompt(title: string, skills: readonly string[]): string {
  if (skills.length === 0) return `What does the ${title} plugin add?`;
  return `Use the ${skills[0]} skill: walk me through what it does.`;
}

/**
 * Builds the Penguin package. Throws DshNotMappableError when the dsh package carries nothing
 * this server can run; the callers turn that into a refusal with its reasons.
 */
export function adaptDshPackage(
  input: ReadonlyMap<string, Uint8Array>,
  entry: DshEntry,
  now = new Date(),
): DshAdaptation {
  // npm tarballs nest everything under `package/`; an index's git source may not.
  const raw = [...input.keys()];
  const prefix = raw.length > 0 && raw.every((p) => p.startsWith("package/")) ? "package/" : "";
  const files = new Map<string, Uint8Array>();
  for (const [path, bytes] of input)
    files.set(path.startsWith(prefix) ? path.slice(prefix.length) : path, bytes);

  const manifestRaw = files.get("package.json");
  if (manifestRaw === undefined) {
    throw new DshNotMappableError(["包里没有 package.json，无法确认它是什么"]);
  }
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(decoder.decode(manifestRaw)) as Record<string, unknown>;
  } catch {
    throw new DshNotMappableError(["package.json 不是合法 JSON"]);
  }

  const dropped: { path: string; reason: string }[] = [];
  /** MCP servers whose own files were carried, by server name. */
  const mcpCarried: { server: string; files: number }[] = [];
  const warnings: string[] = [];
  const out = new Map<string, Uint8Array>();
  let total = 0;

  // 1. Skills.
  const skills = findSkills([...files.keys()]);
  const skillReport: { name: string; from: string; files: number }[] = [];
  for (const skill of skills) {
    const within = [...files.entries()].filter(([path]) =>
      skill.dir === "" ? path === skill.skillFile : path.startsWith(`${skill.dir}/`),
    );
    let copied = 0;
    let skillText: string | null = null;
    for (const [path, bytes] of within) {
      const relative = skill.dir === "" ? path.split("/").pop()! : path.slice(skill.dir.length + 1);
      if (!isText(relative) && !carriesBinary(relative, bytes.byteLength)) {
        dropped.push({
          path,
          reason: "不是文本文件，也不在可携带的二进制白名单里（图片、文档、表格等）",
        });
        continue;
      }
      if (bytes.byteLength > MAX_FILE_BYTES) {
        dropped.push({ path, reason: `单文件超过 ${MAX_FILE_BYTES / 1024 / 1024} MB` });
        continue;
      }
      total += bytes.byteLength;
      if (total > MAX_TOTAL_BYTES) {
        throw new DshNotMappableError([`解出的技能文件超过 ${MAX_TOTAL_BYTES / 1024 / 1024} MB`]);
      }
      if (path === skill.skillFile) {
        const normalized = normalizeSkill(decoder.decode(bytes), skill.name, now);
        skillText = normalized.text;
        out.set(`skills/${skill.name}/SKILL.md`, encoder.encode(normalized.text));
      } else {
        out.set(`skills/${skill.name}/${relative}`, bytes);
      }
      copied += 1;
    }
    if (skillText !== null) {
      // A skill may carry its own package.json with runtime dependencies (a database client,
      // say) and a setup script that installs them. The port carries the files; the operator
      // still has to run that install once, and the report says so.
      const ownManifest = files.get(
        skill.dir === "" ? "package.json" : `${skill.dir}/package.json`,
      );
      let needsSetup = false;
      if (ownManifest !== undefined && ownManifest !== files.get("package.json")) {
        try {
          const parsed = JSON.parse(decoder.decode(ownManifest)) as {
            dependencies?: Record<string, unknown>;
          };
          needsSetup = Object.keys(parsed.dependencies ?? {}).length > 0;
        } catch {
          needsSetup = false;
        }
      }
      if (files.has(skill.dir === "" ? "scripts/setup.sh" : `${skill.dir}/scripts/setup.sh`)) {
        needsSetup = true;
      }
      skillReport.push({
        name: skill.name,
        from: skill.skillFile,
        files: copied,
        ...(needsSetup ? { needsSetup } : {}),
      });
    }
  }

  // 2. MCP servers, and the files a stdio one needs to actually start.
  const servers = readMcpServers(manifest, files);
  const mcpDeclarations = servers.map((server) => {
    const carried = mcpServerFiles(files, server);
    if (carried !== null) {
      // `added` keys are final package paths in both shapes (original paths for a
      // ${PLUGIN_ROOT} config, `mcp/<server>/…` for a rewritten one).
      for (const [rel, bytes] of carried.added) {
        total += bytes.byteLength;
        out.set(rel, bytes);
      }
      mcpCarried.push({ server: server.name, files: carried.added.size });
    }
    const config = carried?.config ?? server.config;
    const keys = setupKeys(config);
    return {
      name: server.name,
      config,
      setup: keys.map((key) => ({ key, label: key })),
    };
  });
  if (total > MAX_TOTAL_BYTES) {
    throw new DshNotMappableError([`解出的文件超过 ${MAX_TOTAL_BYTES / 1024 / 1024} MB`]);
  }

  // 3. What cannot cross the boundary, named rather than lost.
  for (const path of files.keys()) {
    const carried =
      skills.some((s) => (s.dir === "" ? path === s.skillFile : path.startsWith(`${s.dir}/`))) ||
      path === "package.json" ||
      path === "icon.svg" ||
      /^(LICENSE|NOTICE|COPYING)/i.test(path) ||
      path === "README.md";
    if (carried) continue;
    if (path === "index.js" || path === "client.js" || path === "cordis.patch.yml") {
      dropped.push({ path, reason: "Cordis 宿主代码，Penguin 没有对应扩展点" });
    }
  }
  if ([...files.keys()].some((p) => p.startsWith("lib/") || p.startsWith("host/"))) {
    dropped.push({ path: "lib/, host/", reason: "Cordis 宿主代码，Penguin 没有对应扩展点" });
  }

  if (skillReport.length === 0 && mcpDeclarations.length === 0) {
    const reasons = ["它没有可移植的内容：既没有 skills/*/SKILL.md，也没有 MCP 服务器声明"];
    if (files.has("cordis.patch.yml") || files.has("index.js")) {
      reasons.push(
        "它是 Cordis 宿主插件（apply(ctx) 运行在 dsh 进程里），PenguinHarness 没有这套运行时",
      );
    }
    throw new DshNotMappableError(reasons);
  }

  // 4. Icon and licence, when they are simple enough to carry.
  const icon = files.get("icon.svg");
  if (icon !== undefined && isSafeIconSvg(decoder.decode(icon))) out.set("icon.svg", icon);
  for (const path of files.keys()) {
    if (/^(LICENSE|NOTICE|COPYING)/i.test(path)) {
      const bytes = files.get(path)!;
      if (bytes.byteLength <= MAX_FILE_BYTES) out.set(path, bytes);
    }
  }
  const readme = files.get("README.md");
  if (readme !== undefined && readme.byteLength <= MAX_FILE_BYTES) out.set("README.md", readme);

  // 5. The manifest the library reads.
  const title = textEn(entry.title, entry.name);
  const titleZh = textZh(entry.title);
  const description = textEn(entry.description, "");
  const descriptionZh = textZh(entry.description);
  const name = portedPackageName(entry.name);
  const penguin: Record<string, unknown> = {
    title,
    ...(titleZh !== "" ? { titleZh } : {}),
    // The package's one-liner belongs to the CARD. The loader also stamps it onto every skill
    // it installs, so a package with several skills would give them all the same blurb — the
    // dsh index describes the plugin, not each skill. Only a single-skill package may use it.
    ...(description !== "" && skillReport.length <= 1
      ? { short_description: description.slice(0, 140) }
      : {}),
    ...(descriptionZh !== "" ? { description_zh: descriptionZh } : {}),
    ...(penguinCategory(entry.category) !== undefined
      ? { category: penguinCategory(entry.category) }
      : {}),
    ...(icon !== undefined && isSafeIconSvg(decoder.decode(icon)) ? { icon: "icon.svg" } : {}),
    quick_start: {
      prompt: quickStartPrompt(
        title,
        skillReport.map((s) => s.name),
      ),
    },
    ...(mcpDeclarations.length > 0 ? { mcp_servers: mcpDeclarations } : {}),
    ported_from: {
      market: "deepseek-harness",
      package: entry.name,
      version: entry.version,
      source: entry.sourceUrl,
      // A git version is pinned by commit: record it, so what was installed can be traced back
      // even after the index moves on.
      ...(entry.source.type === "git"
        ? {
            git: {
              ...(entry.source.url === undefined ? {} : { url: entry.source.url }),
              ...(entry.source.commit === undefined ? {} : { commit: entry.source.commit }),
              ...(entry.source.path === undefined ? {} : { path: entry.source.path }),
            },
          }
        : {}),
      at: now.toISOString(),
    },
  };
  // The source package's runtime dependencies come along: a ported script or MCP server that
  // needs a client library gets it from the prefix's node_modules at install time.
  const sourceDeps =
    typeof manifest.dependencies === "object" && manifest.dependencies !== null
      ? (manifest.dependencies as Record<string, unknown>)
      : {};
  const pkg = {
    name,
    version: entry.version,
    ...(Object.keys(sourceDeps).length > 0 ? { dependencies: sourceDeps } : {}),
    description: description !== "" ? description : `${title} (ported from DeepSeek Harness)`,
    ...(entry.author !== undefined ? { author: entry.author } : {}),
    ...(entry.homepage !== undefined ? { homepage: entry.homepage } : {}),
    ...(entry.repository !== undefined
      ? { repository: { type: "git", url: entry.repository } }
      : {}),
    ...(typeof manifest.license === "string" ? { license: manifest.license } : {}),
    keywords: [
      ...new Set([
        ...(Array.isArray(manifest.keywords)
          ? manifest.keywords.filter((k): k is string => typeof k === "string")
          : []),
        ...entry.keywords,
        "penguin-plugin",
        "ported",
        "dsh",
      ]),
    ],
    penguin,
  };
  out.set("package.json", encoder.encode(`${JSON.stringify(pkg, null, 2)}\n`));

  if (descriptionZh === "" && titleZh === "") {
    warnings.push("索引没有给中文标题或描述，卡片按英文显示");
  }
  if (mcpDeclarations.length > 0) {
    warnings.push("MCP 服务器原样搬用包里的配置；需要凭据的键会在装到 Agent 时提示填写");
  }
  return {
    files: out,
    report: {
      name,
      version: entry.version,
      title,
      skills: skillReport,
      mcpServers: mcpDeclarations.map((s) => s.name),
      mcpCarried,
      dependencies: Object.keys(sourceDeps),
      dropped,
      warnings,
    },
  };
}
