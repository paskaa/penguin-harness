/**
 * Inbox row state (db/repos/inbox-reads.ts), driven against an in-memory database: one row
 * per (user, project, org, row key) holding a read mark and an archive mark, plus the
 * snapshot an archived mention carries. Each case pins the contract the service relies on —
 * the two marks live in the same row without clobbering each other, a mention snapshot
 * survives an unarchive that does not send one, and reads never leak across people or
 * organizations.
 */
import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/db/database.js";
import { InboxReadsRepo } from "../src/db/repos/inbox-reads.js";

const P = "p1";
const ORG = "acme";
const T0 = "2026-10-19T12:00:00.000Z";

function repo(): InboxReadsRepo {
  const db = openDatabase(":memory:");
  db.prepare(
    "INSERT INTO users (user_id, password_hash, is_admin, created_at) VALUES ('alice', 'h', 0, '2026-01-01T00:00:00Z')",
  ).run();
  db.prepare(
    "INSERT INTO projects (project_id, owner_user_id, created_at) VALUES ('p1', 'alice', '2026-01-01T00:00:00Z')",
  ).run();
  return new InboxReadsRepo(db);
}

describe("inbox reads", () => {
  it("remembers a read mark per key and flips it back", () => {
    const r = repo();
    expect(r.states("alice", P, ORG).size).toBe(0);

    r.setRead("alice", P, ORG, ["mention/m1", "blocked/2026-10-19-x"], true, T0);
    const read = r.states("alice", P, ORG);
    expect(read.get("mention/m1")).toEqual({ read: true, archived: false });
    expect(read.get("blocked/2026-10-19-x")).toEqual({ read: true, archived: false });

    r.setRead("alice", P, ORG, ["mention/m1"], false, T0);
    expect(r.states("alice", P, ORG).get("mention/m1")).toEqual({ read: false, archived: false });
  });

  it("keeps the read mark when a row is archived, and the archive mark when it is read", () => {
    const r = repo();
    r.setRead("alice", P, ORG, ["mention/m1"], true, T0);
    r.setArchived("alice", P, ORG, [{ key: "mention/m1", snapshot: '{"id":"m1"}' }], true, T0);
    // One row per key: archiving spends the same row the read mark lives in.
    expect(r.states("alice", P, ORG).get("mention/m1")).toEqual({ read: true, archived: true });

    r.setRead("alice", P, ORG, ["mention/m1"], true, T0);
    expect(r.states("alice", P, ORG).get("mention/m1")).toEqual({ read: true, archived: true });
  });

  it("keeps a mention's snapshot through an unarchive that sends none, and hands it back archived first", () => {
    const r = repo();
    const snapshot = JSON.stringify({ id: "m1", text: "@user:alice ship it" });
    r.setArchived("alice", P, ORG, [{ key: "mention/m1", snapshot }], true, T0);
    r.setArchived("alice", P, ORG, [{ key: "blocked/2026-10-19-x" }], true, T0);

    expect(r.archived("alice", P, ORG, 10).map((x) => x.rowKey)).toEqual([
      "blocked/2026-10-19-x",
      "mention/m1",
    ]);
    expect(r.archived("alice", P, ORG, 10)[1]!.snapshot).toBe(snapshot);

    // Unarchiving a ticket sends no snapshot; a ticket has none anyway.
    r.setArchived("alice", P, ORG, [{ key: "blocked/2026-10-19-x" }], false, T0);
    expect(r.archived("alice", P, ORG, 10).map((x) => x.rowKey)).toEqual(["mention/m1"]);

    r.setArchived("alice", P, ORG, [{ key: "mention/m1" }], false, T0);
    expect(r.archived("alice", P, ORG, 10)).toEqual([]);
    // The snapshot is not thrown away by an unarchive: re-archiving reuses it.
    r.setArchived("alice", P, ORG, [{ key: "mention/m1" }], true, T0);
    expect(r.archived("alice", P, ORG, 10)[0]!.snapshot).toBe(snapshot);
  });

  it("never leaks state across people, projects or organizations", () => {
    const r = repo();
    r.setRead("alice", P, ORG, ["mention/m1"], true, T0);
    expect(r.states("bob", P, ORG).size).toBe(0);
    expect(r.states("alice", "p2", ORG).size).toBe(0);
    expect(r.states("alice", P, "other").size).toBe(0);
    r.setArchived("alice", P, "other", [{ key: "mention/m1" }], true, T0);
    expect(r.archived("alice", P, ORG, 10)).toEqual([]);
  });

  it("returns the newest archived rows first and clamps the page", () => {
    const r = repo();
    r.setArchived("alice", P, ORG, [{ key: "mention/m1" }], true, "2026-10-19T10:00:00.000Z");
    r.setArchived("alice", P, ORG, [{ key: "mention/m2" }], true, "2026-10-19T11:00:00.000Z");
    r.setArchived("alice", P, ORG, [{ key: "mention/m3" }], true, "2026-10-19T09:00:00.000Z");
    expect(r.archived("alice", P, ORG, 10).map((x) => x.rowKey)).toEqual([
      "mention/m2",
      "mention/m1",
      "mention/m3",
    ]);
    expect(r.archived("alice", P, ORG, 2)).toHaveLength(2);
    expect(r.archived("alice", P, ORG, 0)).toHaveLength(1);
    expect(r.archived("alice", P, ORG, 9999).length).toBeLessThanOrEqual(200);
  });
});
