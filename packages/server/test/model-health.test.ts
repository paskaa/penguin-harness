/**
 * Model health memory (db/repos/model-health.ts), driven against an in-memory database:
 * consecutive transport-failure counts (reset by any success), failover skip selection,
 * and manual quality bans with their cooldown. Every case pins the tracker's pool
 * semantics this echoes — 10 consecutive failures to skip, 3 quality failures to ban
 * for 24h — and the fail-open edges (success creates no row, uncounted codes leave the
 * memory alone, an unreadable ban timestamp bans nothing).
 */
import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/db/database.js";
import {
  MODEL_FAIL_THRESHOLD,
  ModelHealthRepo,
  QFAIL_COOLDOWN_MS,
  QUALITY_FAIL_THRESHOLD,
} from "../src/db/repos/model-health.js";

const P = "p1";
const NOW = Date.parse("2026-10-19T12:00:00.000Z");
const iso = (ms: number): string => new Date(ms).toISOString();

function repo(): ModelHealthRepo {
  const db = openDatabase(":memory:");
  db.prepare(
    "INSERT INTO users (user_id, password_hash, is_admin, created_at) VALUES ('u', 'h', 0, '2026-01-01T00:00:00Z')",
  ).run();
  db.prepare("INSERT INTO projects (project_id, owner_user_id, created_at) VALUES ('p1', 'u', '2026-01-01T00:00:00Z')").run();
  db.prepare("INSERT INTO projects (project_id, owner_user_id, created_at) VALUES ('p2', 'u', '2026-01-01T00:00:00Z')").run();
  return new ModelHealthRepo(db);
}

describe("model-health", () => {
  it("counts consecutive transport failures per model, and skips at the threshold", () => {
    const r = repo();
    for (let i = 0; i < MODEL_FAIL_THRESHOLD - 1; i++) {
      r.noteRequestEnd(P, "custom", "m1", "rate_limited", iso(NOW + i));
    }
    expect(r.skippedModels(P, NOW + 1000)).toEqual([]);
    r.noteRequestEnd(P, "custom", "m1", "timeout", iso(NOW + 1000));
    expect(r.skippedModels(P, NOW + 1001)).toEqual(["custom/m1"]);
    // Another model and another Project are untouched.
    expect(r.skippedModels(P, NOW + 1001)).toEqual(["custom/m1"]);
    expect(r.skippedModels("p2", NOW + 1001)).toEqual([]);
  });

  it("a success resets the count, and creates no row when there is nothing to forget", () => {
    const r = repo();
    r.noteRequestEnd(P, "custom", "fresh", undefined, iso(NOW));
    expect(r.list(P, NOW)).toEqual([]);
    for (let i = 0; i < MODEL_FAIL_THRESHOLD; i++) {
      r.noteRequestEnd(P, "custom", "m1", "network", iso(NOW + i));
    }
    expect(r.skippedModels(P, NOW + 1000)).toEqual(["custom/m1"]);
    r.noteRequestEnd(P, "custom", "m1", undefined, iso(NOW + 1001));
    expect(r.skippedModels(P, NOW + 1002)).toEqual([]);
    expect(r.list(P, NOW + 1002)[0]).toMatchObject({ provider: "custom", modelId: "m1", failures: 0 });
  });

  it("config and content errors leave the memory alone", () => {
    const r = repo();
    for (const code of ["auth", "invalid_input", "malformed", "unsupported", "rejected", "image_rejected"]) {
      r.noteRequestEnd(P, "custom", "m1", code, iso(NOW));
    }
    expect(r.list(P, NOW)).toEqual([]);
    expect(r.skippedModels(P, NOW)).toEqual([]);
  });

  it("quality failures ban at the threshold and the ban lapses after the cooldown", () => {
    const r = repo();
    for (let i = 0; i < QUALITY_FAIL_THRESHOLD - 1; i++) {
      const ans = r.noteQualityFailure(P, "custom", "m1", "bad answer", iso(NOW + i));
      expect(ans.banned).toBe(false);
    }
    expect(r.skippedModels(P, NOW + 1000)).toEqual([]);
    const ans = r.noteQualityFailure(P, "custom", "m1", "bad answer again", iso(NOW + 1000));
    expect(ans).toEqual({ count: QUALITY_FAIL_THRESHOLD, banned: true });
    expect(r.skippedModels(P, NOW + 1001)).toEqual(["custom/m1"]);
    // Still banned just inside the cooldown, free just after it.
    expect(r.skippedModels(P, NOW + 1000 + QFAIL_COOLDOWN_MS - 1)).toEqual(["custom/m1"]);
    expect(r.skippedModels(P, NOW + 1000 + QFAIL_COOLDOWN_MS + 1)).toEqual([]);
    expect(r.list(P, NOW + 1001)[0]).toMatchObject({ qfailCount: 3, qualityBanned: true });
  });

  it("clearing forgets failures and bans independently", () => {
    const r = repo();
    for (let i = 0; i < MODEL_FAIL_THRESHOLD; i++) {
      r.noteRequestEnd(P, "custom", "m1", "rate_limited", iso(NOW + i));
    }
    for (let i = 0; i < QUALITY_FAIL_THRESHOLD; i++) {
      r.noteQualityFailure(P, "custom", "m2", "bad", iso(NOW + i));
    }
    r.clearFailures(P, "custom", "m1");
    expect(r.skippedModels(P, NOW + 5000)).toEqual(["custom/m2"]);
    r.clearQualityFailures(P);
    expect(r.skippedModels(P, NOW + 5001)).toEqual([]);
  });
});
