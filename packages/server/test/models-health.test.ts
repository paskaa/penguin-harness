/**
 * Model health memory API (`/api/projects/:projectId/models/health*`), driven against a
 * booted app: reads for members, reports and clears for owners. Each case pins the
 * tracker's pool semantics this echoes — 3 quality reports to ban, clears that forget
 * failures and bans independently — and the request shapes (pair-together refs, reason
 * cap, scope enum).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { apiClient, createTestApp, provisionUser } from "./helpers.js";
import type { TestApp } from "./helpers.js";
import type { ModelHealthListResponse, QualityReportResponse } from "../src/api/types.js";

describe("models health", () => {
  let t: TestApp;
  let api: ReturnType<typeof apiClient>;
  let member: ReturnType<typeof apiClient>;
  let projectId: string;

  const url = (suffix = "") => `/api/projects/${projectId}/models/health${suffix}`;

  beforeAll(async () => {
    t = await createTestApp();
    api = apiClient(t.app, (await provisionUser(t.app, "gina")).cookie);
    member = apiClient(t.app, (await provisionUser(t.app, "hank")).cookie);
    const created = (await (
      await api.post("/api/projects", { projectId: "gina-health", name: "Health" })
    ).json()) as { project: { projectId: string } };
    projectId = created.project.projectId;
    expect(await (await api.post(`/api/projects/${projectId}/members`, { userId: "hank" })).status).toBe(
      201,
    );
  });
  afterAll(async () => {
    await t.cleanup();
  });

  it("reads empty for owner and member alike", async () => {
    for (const client of [api, member]) {
      const res = await client.get(url());
      expect(res.status).toBe(200);
      expect(((await res.json()) as ModelHealthListResponse).health).toEqual([]);
    }
  });

  it("three quality reports ban the model, and the list shows the ban", async () => {
    for (let i = 1; i <= 3; i++) {
      const res = await api.post(url("/quality"), {
        provider: "custom",
        modelId: "m1",
        reason: `bad answer ${i}`,
      });
      expect(res.status).toBe(200);
      expect((await res.json()) as QualityReportResponse).toEqual({
        provider: "custom",
        modelId: "m1",
        count: i,
        banned: i === 3,
      });
    }
    const listed = ((await (await api.get(url())).json()) as ModelHealthListResponse).health;
    expect(listed).toEqual([
      {
        provider: "custom",
        modelId: "m1",
        failures: 0,
        lastError: null,
        lastFailureAt: null,
        qfailCount: 3,
        qfailAt: expect.any(String),
        qfailReason: "bad answer 3",
        qualityBanned: true,
      },
    ]);
  });

  it("rejects malformed reports and clears", async () => {
    expect((await api.post(url("/quality"), { provider: "custom" })).status).toBe(400);
    expect(
      (await api.post(url("/quality"), { provider: "custom", modelId: "m1", reason: "x".repeat(501) }))
        .status,
    ).toBe(400);
    expect((await api.delete(url("?scope=bogus"))).status).toBe(400);
    expect((await api.delete(url("?provider=custom"))).status).toBe(400);
  });

  it("clears bans without touching failures, and members may neither report nor clear", async () => {
    expect((await member.post(url("/quality"), { provider: "custom", modelId: "m1" })).status).toBe(
      403,
    );
    expect((await member.delete(url("?scope=all"))).status).toBe(403);
    const res = await api.delete(url("?scope=quality&provider=custom&modelId=m1"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ cleared: 1 });
    const listed = ((await (await api.get(url())).json()) as ModelHealthListResponse).health;
    expect(listed[0]).toMatchObject({ qfailCount: 0, qfailAt: null, qualityBanned: false });
    // Nothing left to forget: the next clear touches nothing.
    expect(await (await api.delete(url("?scope=all"))).json()).toEqual({ cleared: 0 });
  });
});
