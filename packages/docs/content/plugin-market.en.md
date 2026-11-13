---
title: DSH plugin market
description: Read a DeepSeek Harness plugin index, convert a dsh plugin into a package this server can run (skills and MCP servers) at install time, and what the conversion can and cannot carry.
---

A DeepSeek Harness (`dsh`) plugin market is one JSON index file listing the plugins published for it. This server's **DSH plugin market** page (sidebar, admins only) reads such an index and, **at install time, converts** a plugin into a package PenguinHarness can run.

A dsh plugin is a **Cordis plugin**: it exports `apply(ctx)`, runs inside the dsh host, and depends on the `@deepseek-ai/dsh-*` services. This server has no such host, so a dsh plugin cannot be installed as it is — only the parts that mean the same thing on both sides can cross.

## Add an index source

1. Open **DSH plugin market** in the sidebar.
2. Paste an index URL under **Index sources** — for example the official market `https://cdn.dsh.so/market/index.json` (about 9.5 MB, 12 576 plugins) or the community list `https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json`.
3. Press **Add index source**. The first read takes seconds to tens of seconds: the row says `Reading…`, the list shows skeletons, and it fills in when the read lands. If it is slow, press **Refresh** at the top right.
4. Only `http(s)` URLs are accepted, without a user name, password or `#` fragment.

Adding the same URL twice does not create a second source. A source that cannot be read is marked red with its reason while the others keep working; a source that has been read once keeps showing its last good content when a later refresh fails.

## Browse and narrow

- **Categories**: the categories the index declares become a row of chips (for example “Tools & data 2374”). One click narrows the list to that category; **All** goes back. The counts follow the current search.
- **Search** covers names, titles, descriptions (both languages) and keywords, and the server does it — the whole index never reaches the browser.
- **Paging**: 60 entries per page, with **Show more** at the bottom.

## What an install does

Pressing **Convert and install** makes the server:

1. fetch that pinned version of the package from npm (npm sources only; a `git` source is refused with a reason);
2. find what can be carried, write a new package under `<data root>/plugins` named `@dsh-ported/<original>`;
3. show a report of **what was carried** and **what had to be left behind**.

| In the dsh package | Result |
| --- | --- |
| `skills/<name>/SKILL.md` (at any depth, e.g. `data/experts/*/skills/*`) and its text files | carried as skills, frontmatter normalised to `name` / `description` / `version` |
| `.mcp.json` or `package.json`'s `mcpServers` | carried into `penguin.mcp_servers`; a `${TOKEN}` placeholder becomes a vault key to fill |
| `icon.svg`, `LICENSE`, `README.md` | carried when they are safe to carry |
| An MCP server's own files: the script `${PLUGIN_ROOT}/server/index.js` names, or the directory `args: ["./server.js"]` sits in | carried with the package (same paths, or rewritten to `${PLUGIN_ROOT}/mcp/<server>/…`); without them the server installs and never starts |
| Images, PDFs, Office documents, archives inside a skill | carried from an allowlist (5 MB each), so a skill can reference them |
| `index.js`, `client.js`, `cordis.patch.yml`, `lib/`, `host/` | **dropped**, each named in the report (Cordis host code; this server has no extension point for it) |

A package with neither skills nor an MCP declaration is **refused**, with the reason — installing an empty shell would do nothing.

The install runs as a background job: fetching and `npm install` take tens of seconds, so the page waits for it (the button reads “Converting…”). A job lost to a server restart is reported as such rather than pretending it worked.

## Before first use: a skill's own dependencies

Some dsh skills ship their own `package.json` and setup script (a database query skill needs `mysql2` and `redis`, for example). Those files are carried over, but the dependencies still have to be installed once — the install report **marks which skills need this**.

After the plugin is installed on an Agent, run the skill's own script in its directory:

```bash
cd <the Agent's agent_state>/skills/db-query && bash scripts/setup.sh   # or npm install --omit=dev
```

The script is idempotent; once `node_modules` exists in the skill directory, the skill's scripts run.

## After it is installed

- What the conversion produced is a **library plugin**: it appears on the **Plugins** page, where it can be installed on an Agent — its skills go into that Agent's skills, its MCP servers into its tool configuration.
- An MCP server that needs credentials asks for its vault keys on that Agent's settings page before it connects.
- Installing the same plugin again replaces `@dsh-ported/<original>`.

## Uninstall

In the DSH plugin market, an installed card shows **Installed vX** and **Remove**, which deletes that package from this server. Skills already installed on an Agent stay there — they belong to the Agent, and are removed from its own settings page.

## Survey: how much of the market can this server run?

The page installs one plugin at a time. To answer the question for the whole catalogue, sample it:

```bash
npx tsx scripts/dsh-market-survey.ts --index https://cdn.dsh.so/market/index.json \
  --sample 50 --out /var/log/dsh-market-survey.json
```

It runs the **real conversion** (fetch → adapt) on N evenly spread plugins and sorts the results
into `ported` / `no-content` (a host-only plugin with nothing to carry) / `fetch-failed` /
`adapt-failed`, reporting how many skills, MCP servers and setup-needing skills the portable ones
carry. Nothing is installed, so it is safe on a timer.

## Limits

- **npm sources only**; a version the index marks as `git` is refused.
- Only **skills and MCP servers** cross. Prompt injection, UI, models, session storage and other deep integrations have no equivalent here.
- The install takes the version the index recommends (the highest release); the page cannot pick an older one yet.
- Two packages of the same name under different scopes (`a/x` and `b/x`) map to one `@dsh-ported/x`.
- An index is third-party content: titles, icons and authors are its publisher's claims. Check the source before installing.
