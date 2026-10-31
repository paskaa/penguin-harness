/**
 * Squad review-vote routes (LOCAL-ONLY: this machine's squad registries, not upstream):
 *   GET  /api/squad/review-vote       -> every registry's vote-gate switch
 *   PUT  /api/squad/review-vote       -> { reviewVote: boolean, key?: string } flips one
 *                                         table (key) or all of them (no key)
 *
 * The switch lives in each registry's own `config.json` (`review_vote`, default false =
 * a human still closes tickets); the dispatcher and `squad_ticket.py` read the files, so
 * this API is only the UI's writer — the company board's review column hosts the button.
 * Writes preserve the file's other keys and create the file when it is missing.
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Hono } from "hono";
import { Bind, Component } from "@prismshadow/penguin-core/kernel";
import type {
  SquadReviewVoteResponse,
  SquadReviewVoteTable,
} from "../../api/types.js";
import type { AppEnv } from "../../auth/middleware.js";
import { badRequest, readJson } from "../validate.js";

/** The registries the dispatcher cycles, in the order the UI lists them. */
export const SQUAD_REGISTRIES: ReadonlyArray<{
  key: string;
  label: string;
  dir: string;
}> = [
  {
    key: "hub",
    label: "Hub（共用）",
    dir: "/root/penguin/scratchpad/squad-benchmark/.squad",
  },
  {
    key: "tracker",
    label: "Tracker",
    dir: "/root/penguin/medical-tender-tracker/.squad",
  },
];

export const SQUAD_CONFIG_FILE = "config.json";
export const SQUAD_VOTE_KEY = "review_vote";

/**
 * The switch off a parsed `config.json`: only an explicit `true` opens the gate —
 * a missing file, invalid JSON or a missing key all mean a human still closes.
 */
export function parseReviewVoteFlag(json: unknown): boolean {
  if (typeof json !== "object" || json === null) return false;
  return (json as Record<string, unknown>)[SQUAD_VOTE_KEY] === true;
}

/** The file's new text: the old keys kept as they were, only the switch flipped. */
export function renderSquadConfig(existing: unknown, reviewVote: boolean): string {
  const base =
    typeof existing === "object" && existing !== null
      ? (existing as Record<string, unknown>)
      : {};
  return JSON.stringify({ ...base, [SQUAD_VOTE_KEY]: reviewVote }, null, 2) + "\n";
}

async function readTable(
  reg: (typeof SQUAD_REGISTRIES)[number],
): Promise<SquadReviewVoteTable> {
  let raw: string | null = null;
  try {
    raw = await readFile(join(reg.dir, SQUAD_CONFIG_FILE), "utf-8");
  } catch {
    raw = null;
  }
  let json: unknown = null;
  if (raw !== null) {
    try {
      json = JSON.parse(raw) as unknown;
    } catch {
      json = null;
    }
  }
  return {
    key: reg.key,
    label: reg.label,
    path: join(reg.dir, SQUAD_CONFIG_FILE),
    reviewVote: parseReviewVoteFlag(json),
  };
}

async function writeTable(
  reg: (typeof SQUAD_REGISTRIES)[number],
  reviewVote: boolean,
): Promise<SquadReviewVoteTable> {
  let existing: unknown = null;
  try {
    existing = JSON.parse(
      await readFile(join(reg.dir, SQUAD_CONFIG_FILE), "utf-8"),
    ) as unknown;
  } catch {
    existing = null;
  }
  await writeFile(
    join(reg.dir, SQUAD_CONFIG_FILE),
    renderSquadConfig(existing, reviewVote),
    "utf-8",
  );
  return {
    key: reg.key,
    label: reg.label,
    path: join(reg.dir, SQUAD_CONFIG_FILE),
    reviewVote,
  };
}

export function squadRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.get("/review-vote", async (c) => {
    const tables: SquadReviewVoteTable[] = [];
    for (const reg of SQUAD_REGISTRIES) tables.push(await readTable(reg));
    const res: SquadReviewVoteResponse = { tables };
    return c.json(res);
  });
  app.put("/review-vote", async (c) => {
    const body = await readJson(c);
    if (typeof body.reviewVote !== "boolean")
      throw badRequest("reviewVote must be a boolean.");
    const reviewVote = body.reviewVote;
    const keys =
      body.key === undefined
        ? SQUAD_REGISTRIES.map((r) => r.key)
        : [String(body.key)];
    for (const k of keys)
      if (!SQUAD_REGISTRIES.some((r) => r.key === k))
        throw badRequest(`unknown squad registry: ${k}.`);
    const tables: SquadReviewVoteTable[] = [];
    for (const reg of SQUAD_REGISTRIES) {
      if (body.key !== undefined && reg.key !== body.key) {
        tables.push(await readTable(reg));
      } else {
        tables.push(await writeTable(reg, reviewVote));
      }
    }
    const res: SquadReviewVoteResponse = { tables };
    return c.json(res);
  });
  return app;
}

@Component({
  contributes: {
    "HttpModule.routes": [
      {
        id: "SquadRoutes.routes",
        prefix: "/api/squad",
        auth: "user",
        order: 147,
      },
    ],
  },
})
export class SquadRoutes {
  @Bind("SquadRoutes.routes") routes!: Hono<AppEnv>;
  setup() {
    this.routes = squadRoutes();
  }
}
