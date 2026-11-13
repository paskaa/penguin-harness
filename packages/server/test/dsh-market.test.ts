/**
 * The DeepSeek Harness market: reading a format-1 index, and turning a listed package into one
 * this server can run.
 *
 * The index rules are the publisher's own (docs/user/guide/plugin-market.md upstream): a document
 * whose format is not 1, a duplicate name or a version without a source is a defect in one
 * publisher's artifact, so it is refused rather than half-read. The adapter carries only what has
 * a PenguinHarness equivalent — skills and MCP servers — and the samples below are trimmed to the
 * shapes real packages have (a root `skills/` directory, skills nested deep in `data/`, and a
 * host-only plugin with neither).
 */
import { describe, expect, it } from "vitest";
import {
  addDshSource,
  checkSourceUrl,
  dshEntries,
  dshSourcesFile,
  parseDshIndex,
  preferredVersion,
  readDshSources,
  removeDshSource,
} from "../src/plugin/dsh-market.js";
import { adaptDshPackage, DshNotMappableError } from "../src/plugin/dsh-adapt.js";
import { parseSkillFrontmatter } from "@prismshadow/penguin-core";
import type { DshEntry } from "../src/plugin/dsh-market.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const encoder = new TextEncoder();
const text = (value: string) => encoder.encode(value);

function entry(overrides: Partial<DshEntry> = {}): DshEntry {
  return {
    name: "dsh-sample",
    version: "1.2.3",
    versions: ["1.2.3"],
    title: { en: "Sample plugin", zh: "示例插件" },
    description: { en: "Adds the sample tool", zh: "增加示例工具" },
    keywords: [],
    source: { type: "npm" },
    sourceId: "source-1",
    sourceUrl: "https://example.com/index.json",
    ...overrides,
  };
}

describe("a dsh index", () => {
  const doc = {
    format: 1,
    title: { en: "Team plugins", zh: "团队插件" },
    plugins: [
      {
        name: "dsh-plugin-foo",
        title: "Foo",
        description: "Adds the foo tool",
        author: "Jane Doe",
        versions: [
          { version: "1.1.0", source: { type: "npm" }, engines: { dsh: ">=0.2.0" } },
          { version: "1.0.0", source: { type: "npm" } },
        ],
      },
      {
        name: "@team/dsh-bar",
        versions: [
          { version: "0.3.0", source: { type: "git", url: "https://gitlab.example.com/t/r" } },
        ],
      },
    ],
  };

  it("reads plugins, versions and sources", () => {
    const index = parseDshIndex(doc);
    expect(index.plugins).toHaveLength(2);
    expect(index.plugins[0]!.versions[0]!.engines?.dsh).toBe(">=0.2.0");
    expect(index.plugins[1]!.versions[0]!.source.type).toBe("git");
  });

  it("flattens one plugin to one row, offering the newest release over a prerelease", () => {
    const index = parseDshIndex({
      format: 1,
      plugins: [
        {
          name: "dsh-plugin-foo",
          versions: [
            { version: "1.2.0-rc.1", source: { type: "npm" } },
            { version: "1.1.0", source: { type: "npm" } },
            { version: "1.0.0", source: { type: "npm" } },
          ],
        },
      ],
    });
    const rows = dshEntries(index, {
      id: "source-1",
      url: "https://example.com/index.json",
      title: "",
      addedAt: 0,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.version).toBe("1.1.0");
    expect(rows[0]!.versions).toEqual(["1.2.0-rc.1", "1.1.0", "1.0.0"]);
  });

  it("falls back to the highest prerelease when nothing is released", () => {
    expect(
      preferredVersion([
        { version: "0.9.0-rc.1", source: { type: "npm" } },
        { version: "0.10.0-beta.2", source: { type: "npm" } },
      ])?.version,
    ).toBe("0.10.0-beta.2");
  });

  it("refuses a document that is not format 1", () => {
    expect(() => parseDshIndex({ format: 2, plugins: [] })).toThrow(/format/);
  });

  it("refuses a duplicate plugin name and an unknown source type", () => {
    expect(() =>
      parseDshIndex({
        format: 1,
        plugins: [
          { name: "a", versions: [{ version: "1.0.0", source: { type: "npm" } }] },
          { name: "a", versions: [{ version: "1.0.0", source: { type: "npm" } }] },
        ],
      }),
    ).toThrow(/重复/);
    expect(() =>
      parseDshIndex({
        format: 1,
        plugins: [{ name: "a", versions: [{ version: "1.0.0", source: { type: "ftp" } }] }],
      }),
    ).toThrow(/source\.type/);
  });

  it("keeps every source when two are added at once", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "dsh-race-"));
    try {
      // Two admins saving together must not erase each other's row (the store serializes writes).
      await Promise.all([
        addDshSource(root, "https://example.com/one.json", 1),
        addDshSource(root, "https://example.com/two.json", 2),
        addDshSource(root, "https://example.com/three.json", 3),
      ]);
      const urls = (await readDshSources(root)).map((s) => s.url).sort();
      expect(urls).toEqual([
        "https://example.com/one.json",
        "https://example.com/three.json",
        "https://example.com/two.json",
      ]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("accepts http(s) source URLs only, without credentials or fragments", () => {
    expect(checkSourceUrl("https://cdn.example.com/index.json")).toBeNull();
    expect(checkSourceUrl("http://example.com/index.json")).toBeNull();
    expect(checkSourceUrl("ftp://example.com/index.json")).toMatch(/http/);
    expect(checkSourceUrl("https://user:pw@example.com/index.json")).toMatch(/用户名/);
    expect(checkSourceUrl("https://example.com/index.json#x")).toMatch(/#/);
    expect(checkSourceUrl("not a url")).toMatch(/URL/);
  });

  // Filesystem work on a loaded machine can take seconds; the assertions are what matter.
  it("keeps the sources an operator added, in order, and removes one by id", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "dsh-sources-"));
    try {
      const first = await addDshSource(root, "https://example.com/a.json", 1);
      const second = await addDshSource(root, "https://example.com/b.json", 2);
      // Adding the same URL twice is the same source, not a second one.
      expect((await addDshSource(root, "https://example.com/a.json", 3)).id).toBe(first.id);
      expect((await readDshSources(root)).map((s) => s.url)).toEqual([
        "https://example.com/a.json",
        "https://example.com/b.json",
      ]);
      expect(await removeDshSource(root, first.id)).toBe(true);
      expect((await readDshSources(root)).map((s) => s.id)).toEqual([second.id]);
      expect(await removeDshSource(root, "nope")).toBe(false);
      expect(dshSourcesFile(root)).toBe(path.join(root, "dsh-market.json"));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("a dsh package adapted to a Penguin plugin package", () => {
  /** A package with a root skills directory, as dsh-switchman ships one. */
  const rootSkills = new Map<string, Uint8Array>([
    [
      "package.json",
      text(JSON.stringify({ name: "dsh-sample", version: "1.2.3", license: "MIT" })),
    ],
    ["index.js", text("export function apply(ctx) {}")],
    ["cordis.patch.yml", text("- name: ./index.js")],
    [
      "skills/db-query/SKILL.md",
      text("---\nname: db-query\ndescription: Read-only SQL.\n---\n\n# DB query\n"),
    ],
    ["skills/db-query/scripts/query.mjs", text("console.log('hi')")],
    ["skills/db-query/logo.png", new Uint8Array([0x89, 0x50, 0x4e, 0x47])],
  ]);

  it("carries skills, rewrites their frontmatter, and names what it left behind", () => {
    const adapted = adaptDshPackage(rootSkills, entry(), new Date("2026-11-12T00:00:00Z"));
    expect(adapted.report.name).toBe("@dsh-ported/dsh-sample");
    expect(adapted.report.skills.map((s) => s.name)).toEqual(["db-query"]);
    expect(adapted.files.has("skills/db-query/SKILL.md")).toBe(true);
    expect(adapted.files.has("skills/db-query/scripts/query.mjs")).toBe(true);
    // A picture is an allowlisted asset: it travels as bytes, because this skill needs it.
    expect(adapted.files.get("skills/db-query/logo.png")).toBeInstanceOf(Uint8Array);
    // The host code has no Penguin equivalent.
    expect(adapted.report.dropped.some((d) => d.path === "index.js")).toBe(true);
    expect(adapted.report.dropped.some((d) => d.path === "cordis.patch.yml")).toBe(true);

    const manifest = JSON.parse(new TextDecoder().decode(adapted.files.get("package.json")!)) as {
      name: string;
      penguin: { title?: string; titleZh?: string; ported_from?: { package?: string } };
    };
    expect(manifest.name).toBe("@dsh-ported/dsh-sample");
    expect(manifest.penguin.title).toBe("Sample plugin");
    expect(manifest.penguin.titleZh).toBe("示例插件");
    expect(manifest.penguin.ported_from?.package).toBe("dsh-sample");

    const skill = new TextDecoder().decode(adapted.files.get("skills/db-query/SKILL.md")!);
    expect(skill.startsWith("---\nname: db-query\n")).toBe(true);
    expect(skill).toContain("version: 2026.11.12.1\n---\n");
    const parsedSkill = parseSkillFrontmatter(skill);
    expect(parsedSkill?.name).toBe("db-query");
    expect(parsedSkill?.description).toBe("Read-only SQL.");
    expect(parsedSkill?.version).toBe("2026.11.12.1");
  });

  it("finds skills nested anywhere, as a roster package ships them", () => {
    const nested = new Map<string, Uint8Array>([
      ["package.json", text(JSON.stringify({ name: "dsh-roster", version: "0.5.28" }))],
      [
        "data/experts/design/design-to-code/skills/design-to-code-workflows/SKILL.md",
        text(
          "---\nname: design-to-code-workflows\ndescription: Turn a design into code.\n---\n\nBody.\n",
        ),
      ],
    ]);
    const adapted = adaptDshPackage(
      nested,
      entry({ name: "dsh-roster" }),
      new Date("2026-11-12T00:00:00Z"),
    );
    expect(adapted.report.skills.map((s) => s.name)).toEqual(["design-to-code-workflows"]);
    expect(adapted.files.has("skills/design-to-code-workflows/SKILL.md")).toBe(true);
  });

  it("gives two skills of the same name distinct directories that their frontmatter agrees with", () => {
    const collide = new Map<string, Uint8Array>([
      ["package.json", text(JSON.stringify({ name: "dsh-twin", version: "1.0.0" }))],
      [
        "a/skills/review/SKILL.md",
        text("---\nname: review\ndescription: First review.\n---\n\nOne.\n"),
      ],
      [
        "b/skills/review/SKILL.md",
        text("---\nname: review\ndescription: Second review.\n---\n\nTwo.\n"),
      ],
    ]);
    const adapted = adaptDshPackage(collide, entry({ name: "dsh-twin" }));
    const names = adapted.report.skills.map((s) => s.name);
    expect(new Set(names).size).toBe(2);
    for (const name of names) {
      const skill = new TextDecoder().decode(adapted.files.get(`skills/${name}/SKILL.md`)!);
      expect(parseSkillFrontmatter(skill)?.name).toBe(name);
    }
  });

  it("converts declared MCP servers into the package's own list", () => {
    const withMcp = new Map<string, Uint8Array>([
      ["package.json", text(JSON.stringify({ name: "dsh-mcp", version: "1.0.0" }))],
      [
        ".mcp.json",
        text(
          JSON.stringify({
            mcpServers: {
              remote: {
                type: "http",
                url: "https://mcp.example.com/mcp",
                headers: { Authorization: "Bearer ${TOKEN}" },
              },
              local: { command: "node", args: ["server.js"] },
            },
          }),
        ),
      ],
    ]);
    const adapted = adaptDshPackage(withMcp, entry({ name: "dsh-mcp" }));
    const manifest = JSON.parse(new TextDecoder().decode(adapted.files.get("package.json")!)) as {
      penguin: {
        mcp_servers?: { name: string; config: Record<string, unknown>; setup: { key: string }[] }[];
      };
    };
    const servers = manifest.penguin.mcp_servers ?? [];
    expect(servers.map((s) => s.name)).toEqual(["remote", "local"]);
    expect(servers[0]!.config).toMatchObject({
      transport: "http",
      url: "https://mcp.example.com/mcp",
    });
    expect(servers[0]!.setup.map((s) => s.key)).toEqual(["TOKEN"]);
    expect(servers[1]!.config).toMatchObject({ transport: "stdio", command: "node" });
  });

  it("refuses a host-only plugin instead of installing an empty package", () => {
    const hostOnly = new Map<string, Uint8Array>([
      ["package.json", text(JSON.stringify({ name: "dsh-host", version: "0.1.2" }))],
      ["index.js", text("export function apply(ctx) {}")],
      ["cordis.patch.yml", text("- name: ./index.js")],
    ]);
    expect(() => adaptDshPackage(hostOnly, entry({ name: "dsh-host" }))).toThrow(
      DshNotMappableError,
    );
    try {
      adaptDshPackage(hostOnly, entry({ name: "dsh-host" }));
    } catch (err) {
      expect((err as DshNotMappableError).reasons.join(" ")).toMatch(/Cordis/);
    }
  });
});

describe("a ported skill's frontmatter survives the parser that reads it", () => {
  it("round-trips a description with a colon, quotes and a hash", async () => {
    const { parseSkillFrontmatter } = await import("@prismshadow/penguin-core");
    const nasty = 'Read-only SQL: never write; "quoted" and #hash and - dash';
    const pkg = new Map<string, Uint8Array>([
      ["package.json", text(JSON.stringify({ name: "dsh-tricky", version: "1.0.0" }))],
      ["skills/tricky/SKILL.md", text(`---\nname: tricky\ndescription: ${nasty}\n---\n\nBody.\n`)],
    ]);
    const adapted = adaptDshPackage(
      pkg,
      entry({ name: "dsh-tricky" }),
      new Date("2026-11-12T00:00:00Z"),
    );
    const skill = new TextDecoder().decode(adapted.files.get("skills/tricky/SKILL.md")!);
    const parsed = parseSkillFrontmatter(skill);
    expect(parsed).not.toBeNull();
    expect(parsed?.name).toBe("tricky");
    expect(parsed?.description).toBe(nasty);
    expect(parsed?.version).toBe("2026.11.12.1");
  });
});

describe("entries list versions newest first", () => {
  it("sorts the version list, whatever order the index gave", () => {
    const index = parseDshIndex({
      format: 1,
      plugins: [
        {
          name: "dsh-order",
          versions: [
            { version: "1.0.0", source: { type: "npm" } },
            { version: "1.10.0", source: { type: "npm" } },
            { version: "1.2.0-rc.1", source: { type: "npm" } },
          ],
        },
      ],
    });
    const rows = dshEntries(index, { id: "s", url: "https://x/i.json", title: "", addedAt: 0 });
    expect(rows[0]!.versions[0]).toBe("1.10.0");
    expect(rows[0]!.version).toBe("1.10.0");
  });
});

describe("a git-sourced version", () => {
  it("resolves an archive URL at the pinned commit, per host", async () => {
    const { gitArchiveUrl } = await import("../src/plugin/dsh-fetch.js");
    expect(gitArchiveUrl({ url: "https://github.com/o/r", commit: "abc123" })).toBe(
      "https://codeload.github.com/o/r/tar.gz/abc123",
    );
    expect(gitArchiveUrl({ url: "https://github.com/o/r.git", commit: "abc123" })).toBe(
      "https://codeload.github.com/o/r/tar.gz/abc123",
    );
    expect(gitArchiveUrl({ url: "https://gitlab.example.com/team/mono", commit: "9f8e" })).toBe(
      "https://gitlab.example.com/team/mono/-/archive/9f8e/mono-9f8e.tar.gz",
    );
    expect(gitArchiveUrl({ url: "https://git.example.com/o/r", commit: "1a2b" })).toBe(
      "https://git.example.com/o/r/archive/1a2b.tar.gz",
    );
  });

  it("refuses a repository that is not pinned to a commit", async () => {
    const { gitArchiveUrl, DshFetchError } = await import("../src/plugin/dsh-fetch.js");
    expect(() => gitArchiveUrl({ url: "https://github.com/o/r" })).toThrow(DshFetchError);
    expect(() => gitArchiveUrl({ commit: "abc123" })).toThrow(/仓库地址/);
    expect(() => gitArchiveUrl({ url: "https://github.com/o", commit: "abc" })).toThrow(/仓库/);
  });
});

describe("a repository archive", () => {
  it("reads the named directory out of a monorepo, and nothing beside it", async () => {
    const { unpackArchive } = await import("../src/plugin/dsh-fetch.js");
    const tar = await import("tar");
    const fsx = await import("node:fs/promises");
    const osx = await import("node:os");
    const pathx = await import("node:path");

    const work = await fsx.mkdtemp(pathx.join(osx.tmpdir(), "dsh-tar-test-"));
    try {
      const tree = pathx.join(work, "repo-main");
      await fsx.mkdir(pathx.join(tree, "packages/foo/skills/bar"), { recursive: true });
      await fsx.mkdir(pathx.join(tree, "packages/other"), { recursive: true });
      await fsx.writeFile(pathx.join(tree, "README.md"), "# repo\n");
      await fsx.writeFile(pathx.join(tree, "packages/foo/package.json"), '{"name":"foo"}\n');
      await fsx.writeFile(
        pathx.join(tree, "packages/foo/skills/bar/SKILL.md"),
        "---\nname: bar\ndescription: A skill.\n---\n",
      );
      await fsx.writeFile(pathx.join(tree, "packages/other/index.js"), "x\n");
      const archive = pathx.join(work, "repo.tgz");
      await tar.c({ gzip: true, file: archive, cwd: work }, ["repo-main"]);

      const files = await unpackArchive(archive, "packages/foo");
      expect([...files.keys()].sort()).toEqual(["package.json", "skills/bar/SKILL.md"]);
      expect(new TextDecoder().decode(files.get("skills/bar/SKILL.md")!)).toContain("name: bar");
    } finally {
      await fsx.rm(work, { recursive: true, force: true });
    }
  }, 30_000);

  it("takes the archive's single top directory when no inner path is named", async () => {
    const { unpackArchive } = await import("../src/plugin/dsh-fetch.js");
    const tar = await import("tar");
    const fsx = await import("node:fs/promises");
    const osx = await import("node:os");
    const pathx = await import("node:path");

    const work = await fsx.mkdtemp(pathx.join(osx.tmpdir(), "dsh-tar-test-"));
    try {
      const tree = pathx.join(work, "repo-main");
      await fsx.mkdir(pathx.join(tree, "skills/x"), { recursive: true });
      await fsx.writeFile(pathx.join(tree, "package.json"), '{"name":"standalone"}\n');
      await fsx.writeFile(
        pathx.join(tree, "skills/x/SKILL.md"),
        "---\nname: x\ndescription: X.\n---\n",
      );
      const archive = pathx.join(work, "repo.tgz");
      await tar.c({ gzip: true, file: archive, cwd: work }, ["repo-main"]);

      const files = await unpackArchive(archive, "");
      expect([...files.keys()].sort()).toEqual(["package.json", "skills/x/SKILL.md"]);
    } finally {
      await fsx.rm(work, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("what a converted package carries besides skills", () => {
  it("keeps an allowlisted binary asset in the skill, and refuses an arbitrary blob", () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const pkg = new Map<string, Uint8Array>([
      ["package.json", text(JSON.stringify({ name: "dsh-assets", version: "1.0.0" }))],
      [
        "skills/report/SKILL.md",
        text(
          "---\nname: report\ndescription: Renders a report.\n---\n\nUse ./references/logo.png\n",
        ),
      ],
      ["skills/report/references/logo.png", png],
      ["skills/report/references/payload.exe", new Uint8Array([0x4d, 0x5a, 1, 2, 3])],
    ]);
    const adapted = adaptDshPackage(
      pkg,
      entry({ name: "dsh-assets" }),
      new Date("2026-11-13T00:00:00Z"),
    );
    const logo = adapted.files.get("skills/report/references/logo.png");
    expect(logo).toBeInstanceOf(Uint8Array);
    expect([...(logo as Uint8Array)]).toEqual([...png]);
    expect(adapted.files.has("skills/report/references/payload.exe")).toBe(false);
    expect(adapted.report.dropped.some((d) => d.path.endsWith("payload.exe"))).toBe(true);
  });

  it("carries a stdio MCP server's own files and points the config at them", () => {
    const pkg = new Map<string, Uint8Array>([
      ["package.json", text(JSON.stringify({ name: "dsh-mcp-files", version: "1.0.0" }))],
      [
        ".mcp.json",
        text(
          JSON.stringify({ mcpServers: { helper: { command: "node", args: ["./server.js"] } } }),
        ),
      ],
      ["server.js", text("require('./lib/handler')\n")],
      ["lib/handler.js", text("module.exports = {}\n")],
    ]);
    const adapted = adaptDshPackage(
      pkg,
      entry({ name: "dsh-mcp-files" }),
      new Date("2026-11-13T00:00:00Z"),
    );
    expect(adapted.files.has("mcp/helper/server.js")).toBe(true);
    expect(adapted.files.has("mcp/helper/lib/handler.js")).toBe(true);
    const manifest = JSON.parse(new TextDecoder().decode(adapted.files.get("package.json")!)) as {
      penguin: { mcp_servers: { name: string; config: { args?: string[] } }[] };
    };
    const server = manifest.penguin.mcp_servers.find((s) => s.name === "helper")!;
    expect(server.config.args?.[0]).toBe("${PLUGIN_ROOT}/mcp/helper/server.js");
    expect(adapted.report.mcpCarried).toEqual([{ server: "helper", files: 2 }]);
  });
});
