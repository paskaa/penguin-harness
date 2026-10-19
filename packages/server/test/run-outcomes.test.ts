/**
 * Run outcomes (db/repos/run-outcomes.ts), driven against an in-memory database: one
 * row per driven run, newest-first reads per session. Each case pins the substrate
 * contract — outcomes are a fixed trio, the failure code rides along, reads never
 * leak across sessions.
 */
import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/db/database.js";
import { RunOutcomesRepo } from "../src/db/repos/run-outcomes.js";

const P = "p1";
const A = "a1";
const T0 = Date.parse("2026-10-19T12:00:00.000Z");
const iso = (ms: number): string => new Date(ms).toISOString();

function repo(): RunOutcomesRepo {
  const db = openDatabase(":memory:");
  db.prepare(
    "INSERT INTO users (user_id, password_hash, is_admin, created_at) VALUES ('u', 'h', 0, '2026-01-01T00:00:00Z')",
  ).run();
  db.prepare(
    "INSERT INTO projects (project_id, owner_user_id, created_at) VALUES ('p1', 'u', '2026-01-01T00:00:00Z')",
  ).run();
  return new RunOutcomesRepo(db);
}

describe("run-outcomes", () => {
  it("records runs and reads them newest-first per session", () => {
    const r = repo();
    r.record({
      projectId: P,
      agentId: A,
      sessionId: "s1",
      startedAt: iso(T0),
      endedAt: iso(T0 + 1000),
      outcome: "completed",
    });
    r.record({
      projectId: P,
      agentId: A,
      sessionId: "s1",
      startedAt: iso(T0 + 2000),
      endedAt: iso(T0 + 3000),
      outcome: "failed",
      errorCode: "llm_fatal",
    });
    r.record({
      projectId: P,
      agentId: A,
      sessionId: "s2",
      startedAt: iso(T0 + 4000),
      endedAt: iso(T0 + 5000),
      outcome: "aborted",
    });
    expect(r.recentBySession(P, A, "s1", 10)).toEqual([
      {
        id: expect.any(Number),
        projectId: P,
        agentId: A,
        sessionId: "s1",
        startedAt: iso(T0 + 2000),
        endedAt: iso(T0 + 3000),
        outcome: "failed",
        errorCode: "llm_fatal",
      },
      {
        id: expect.any(Number),
        projectId: P,
        agentId: A,
        sessionId: "s1",
        startedAt: iso(T0),
        endedAt: iso(T0 + 1000),
        outcome: "completed",
        errorCode: null,
      },
    ]);
    expect(r.recentBySession(P, A, "s2", 10)).toHaveLength(1);
    expect(r.recentBySession(P, A, "s1", 1)).toHaveLength(1);
    expect(r.recentBySession(P, A, "ghost", 10)).toEqual([]);
  });
});
