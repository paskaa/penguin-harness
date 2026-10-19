/**
 * Session runs API (`GET /api/sessions/:sessionId/runs`), driven against a booted app:
 * newest-first outcomes, access-gated like the session itself, with a bounded limit.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { apiClient, createTestApp, provisionUser } from "./helpers.js";
import type { TestApp } from "./helpers.js";
import { RunOutcomesRepo } from "../src/db/repos/run-outcomes.js";
import { sessionRow, uniqueSessionId } from "./fixtures/session.js";
import type { SessionRunsResponse } from "../src/api/types.js";

const PROJECT = "runsuser-runs";

describe("session runs routes", () => {
  let t: TestApp;
  let api: ReturnType<typeof apiClient>;
  let outsider: ReturnType<typeof apiClient>;
  let SID: string;

  beforeAll(async () => {
    t = await createTestApp();
    api = apiClient(t.app, (await provisionUser(t.app, "runsuser")).cookie);
    outsider = apiClient(t.app, (await provisionUser(t.app, "outsider_r")).cookie);
    await api.post("/api/projects", { projectId: PROJECT, name: "Runs" });
    SID = uniqueSessionId();
    t.deps.sessionsRepo.insert(sessionRow(SID, { projectId: PROJECT }));
    const repo = new RunOutcomesRepo(t.deps.db);
    repo.record({
      projectId: PROJECT,
      agentId: "default_agent",
      sessionId: SID,
      startedAt: "2026-10-19T10:00:00.000Z",
      endedAt: "2026-10-19T10:01:00.000Z",
      outcome: "completed",
    });
    repo.record({
      projectId: PROJECT,
      agentId: "default_agent",
      sessionId: SID,
      startedAt: "2026-10-19T10:02:00.000Z",
      endedAt: "2026-10-19T10:03:00.000Z",
      outcome: "failed",
      errorCode: "llm_fatal",
    });
  }, 60_000);
  afterAll(async () => {
    await t.cleanup();
  });

  it("lists newest-first with the failure code, gated like the session", async () => {
    const res = await api.get(`/api/sessions/${SID}/runs`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as SessionRunsResponse).runs).toEqual([
      {
        startedAt: "2026-10-19T10:02:00.000Z",
        endedAt: "2026-10-19T10:03:00.000Z",
        outcome: "failed",
        errorCode: "llm_fatal",
      },
      {
        startedAt: "2026-10-19T10:00:00.000Z",
        endedAt: "2026-10-19T10:01:00.000Z",
        outcome: "completed",
      },
    ]);
    expect((await outsider.get(`/api/sessions/${SID}/runs`)).status).toBe(404);
    expect((await api.get(`/api/sessions/session-ghost/runs`)).status).toBe(404);
  });

  it("bounds the limit", async () => {
    expect((await api.get(`/api/sessions/${SID}/runs?limit=1`)).status).toBe(200);
    expect((((await (await api.get(`/api/sessions/${SID}/runs?limit=1`)).json()) as SessionRunsResponse).runs)).toHaveLength(1);
    expect((await api.get(`/api/sessions/${SID}/runs?limit=0`)).status).toBe(400);
    expect((await api.get(`/api/sessions/${SID}/runs?limit=201`)).status).toBe(400);
    expect((await api.get(`/api/sessions/${SID}/runs?limit=many`)).status).toBe(400);
  });
});
