/**
 * `GET /messages` without a window (`tailLimit` / `before`) reads the WHOLE transcript, and a
 * Session whose Trace is very large cannot be serialized into one response — the largest one on
 * this install holds ~850 MB of shards, and the read ended in
 * `RangeError: Invalid string length` after nine minutes.
 *
 * The route now measures the shards first (stats only) and, past the guard, answers with the
 * tail window the client would have asked for: `page.autoWindowed` says the answer is a window
 * rather than everything, and `page.before` pages back. A Session under the guard keeps the old
 * whole-transcript answer, unchanged, with no `page` at all.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { assistantText, requestBegin, sessionMeta, taskBegin, userText } from "@prismshadow/penguin-core";
import type { MessagesResponse } from "../src/api/types.js";
import { sessionRow } from "./fixtures/session.js";
import { apiClient, createTestApp, provisionUser, writeTraceFile } from "./helpers.js";
import type { TestApp } from "./helpers.js";

const PROJECT = "guard-default_project";
const AGENT = "default_agent";
const DAY = "2026-11-01";
const ENV = "PENGUIN_MESSAGES_FULL_READ_LIMIT_BYTES";

function shard(sessionId: string): ReturnType<typeof userText>[] {
  const records = [
    sessionMeta({
      session_id: sessionId,
      model_id: "m",
      provider: "custom",
      model_context_window: 200000,
      system_prompt: "",
      agent_state: "/a",
      workspace: "/w",
      source: "user",
    }),
    taskBegin(),
    userText("hello"),
    requestBegin(),
    assistantText("hi"),
  ];
  return records as unknown as ReturnType<typeof userText>[];
}

describe("GET /messages guards an unwindowed read of a large Session", () => {
  let t: TestApp;
  let api: ReturnType<typeof apiClient>;
  let sid: string;

  beforeAll(async () => {
    t = await createTestApp();
    api = apiClient(t.app, (await provisionUser(t.app, "guard")).cookie);
    sid = `session-2026-11-01-00-00-00-abcdef12`;
    t.deps.sessionsRepo.insert(sessionRow(sid, { projectId: PROJECT, agentId: AGENT }));
    await writeTraceFile(t.root, PROJECT, AGENT, DAY, sid, 1, shard(sid));
  });
  afterAll(async () => {
    delete process.env[ENV];
    await t.cleanup();
  });
  afterEach(() => {
    delete process.env[ENV];
  });

  it("returns the whole transcript when the Session is under the guard, with no page envelope", async () => {
    delete process.env[ENV];
    const res = await api.get(`/api/sessions/${sid}/messages`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as MessagesResponse;
    expect(body.page).toBeUndefined();
    expect(JSON.stringify(body.messages)).toContain("hello");
  });

  it("answers a bare read past the guard with the tail window, and says so", async () => {
    // Any non-zero threshold below this Trace's size forces the guard; the shard is a few KB.
    process.env[ENV] = "16";
    const res = await api.get(`/api/sessions/${sid}/messages`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as MessagesResponse;
    expect(body.page?.autoWindowed).toBe(true);
    // A window, not a 500: bounded by the default page size and carrying a cursor back.
    expect(body.messages.length).toBeGreaterThan(0);
    expect(body.messages.length).toBeLessThanOrEqual(200);
    expect(JSON.stringify(body.messages)).not.toContain("Invalid string length");
  });

  it("an explicit window is unaffected by the guard", async () => {
    process.env[ENV] = "16";
    const res = await api.get(`/api/sessions/${sid}/messages?tailLimit=2`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as MessagesResponse;
    expect(body.page?.autoWindowed).toBeUndefined();
    expect(body.messages.length).toBeGreaterThan(0);
  });
});
