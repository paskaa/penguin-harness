/**
 * Workflow service semantics on the org harness (real OrganizationService, temp dirs):
 * exit gates block `advance` until a prefixed ticket reaches review, transitions announce
 * themselves in the all-hands channel, export renders auditable Markdown, and definition
 * upgrades require a newer version while old instances report the mismatch.
 */
import fs from "node:fs/promises";
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CHANNEL_ID } from "../src/organization/paths.js";
import { makeOrgHarness } from "./org-harness.js";
import type { OrgHarness } from "./org-harness.js";

const P = "p1";
const ORG = "tenderco";
const T0 = Date.parse("2026-11-01T01:00:00Z");
const ACTOR = { userId: "alice" };

async function tenderInstance(h: OrgHarness, bizKey = "term-99", title = "测试项目") {
  const { service } = h;
  await service.create(P, { orgId: ORG, name: "TenderCo", mission: "把招标做完" }, "alice");
  return service.createWorkflowInstance(
    P,
    ORG,
    { definitionId: "bidding-v1", bizKey, title },
    ACTOR,
  );
}

async function channelTexts(h: OrgHarness): Promise<string[]> {
  const { store } = h;
  const dir = store.dir(P, ORG);
  const days = await store.listMessageDays(dir, DEFAULT_CHANNEL_ID);
  const out: string[] = [];
  for (const day of days) {
    const { messages } = await store.readMessageDay(dir, DEFAULT_CHANNEL_ID, day);
    out.push(...messages.map((m) => m.text));
  }
  return out;
}

async function approveAndAdvance(
  h: OrgHarness,
  instanceId: string,
  req: { skip?: string } = {},
) {
  const { service } = h;
  await service.approveWorkflowInstance(P, ORG, instanceId, {}, ACTOR);
  return service.advanceWorkflowInstance(P, ORG, instanceId, req, ACTOR);
}

describe("workflow service", () => {
  let h: OrgHarness;
  beforeEach(async () => {
    // The shared harness wires an AI double that approves everything, so the
    // everyday flows below exercise the automatic audit; dedicated cases cover
    // rejection, failure and the human override with their own doubles.
    h = await makeOrgHarness({
      nowMs: T0,
      completeOnce: async () => ({ ok: true, text: '{"decision":"approve","reason":"模型：可以推进"}' }),
    });
  });

  it("walks text-gated stages freely but holds prefixed gates until review", async () => {
    const { service } = h;
    const inst = await tenderInstance(h);
    expect(inst.currentStage).toBe("capture");
    // capture → terms → analysis → response: text gates only, no attachments needed
    // (each stage still needs its audit first).
    for (const want of ["terms", "analysis", "response"]) {
      const next = await approveAndAdvance(h, inst.instanceId);
      expect(next.currentStage).toBe(want);
      inst.currentStage = want;
    }
    // Leaving without an audit is refused even where gates would pass.
    await service.rejectWorkflowInstance(P, ORG, inst.instanceId, { to: "capture", reason: "回" }, ACTOR);
    await expect(
      service.advanceWorkflowInstance(P, ORG, inst.instanceId, {}, ACTOR),
    ).rejects.toMatchObject({ code: "workflow_not_approved" });
    // Re-walk to response (audits included) for the gate part.
    for (const want of ["terms", "analysis", "response"]) {
      const next = await approveAndAdvance(h, inst.instanceId);
      inst.currentStage = next.currentStage;
    }
    expect(inst.currentStage).toBe("response");
    // response → demo needs a resp-* ticket in review: blocked with its link.
    await service.approveWorkflowInstance(P, ORG, inst.instanceId, {}, ACTOR);
    await expect(
      service.advanceWorkflowInstance(P, ORG, inst.instanceId, {}, ACTOR),
    ).rejects.toMatchObject({ code: "workflow_gate_unmet" });
    const ticket = await service.createTicket(P, ORG, { title: "响应文件", slug: "resp-doc" }, ACTOR);
    await service.attachWorkflowTicket(P, ORG, inst.instanceId, { ticketId: ticket.ticketId }, ACTOR);
    // Attached but still proposed: still held.
    await expect(
      service.advanceWorkflowInstance(P, ORG, inst.instanceId, {}, ACTOR),
    ).rejects.toMatchObject({ code: "workflow_gate_unmet" });
    await service.moveTicket(P, ORG, ticket.ticketId, "review", undefined, ACTOR);
    const demo = await approveAndAdvance(h, inst.instanceId);
    expect(demo.currentStage).toBe("demo");
    expect(demo.attachments).toContain(ticket.ticketId);
  });

  it("announces advances and rejects in the all-hands channel", async () => {
    const { service } = h;
    const inst = await tenderInstance(h, "term-7", "大厅广播项目");
    await approveAndAdvance(h, inst.instanceId);
    await service.rejectWorkflowInstance(
      P,
      ORG,
      inst.instanceId,
      { reason: "要点缺失" },
      ACTOR,
    );
    const texts = await channelTexts(h);
    const advanced = texts.find((t) => t.includes("推进") && t.includes("大厅广播项目"));
    const rejected = texts.find((t) => t.includes("驳回") && t.includes("要点缺失"));
    expect(advanced).toContain("线索抓取");
    expect(rejected).toContain("要点解析");
  });

  it("skips a skippable stage and exports the audit trail", async () => {
    const { service } = h;
    const inst = await tenderInstance(h);
    for (let i = 0; i < 3; i++) {
      const next = await approveAndAdvance(h, inst.instanceId);
      inst.currentStage = next.currentStage;
    }
    expect(inst.currentStage).toBe("response");
    // Leaving response still needs its own gates proven; demo is the skippable one.
    const ticket = await service.createTicket(P, ORG, { title: "响应文件", slug: "resp-doc" }, ACTOR);
    await service.attachWorkflowTicket(P, ORG, inst.instanceId, { ticketId: ticket.ticketId }, ACTOR);
    await service.moveTicket(P, ORG, ticket.ticketId, "review", undefined, ACTOR);
    // Leaving response still needs its own audit; only demo is bypassed.
    await service.approveWorkflowInstance(P, ORG, inst.instanceId, {}, ACTOR);
    // Pure-service project: skip demo straight into qa.
    const qa = await service.advanceWorkflowInstance(
      P,
      ORG,
      inst.instanceId,
      { skip: "demo" },
      ACTOR,
    );
    expect(qa.currentStage).toBe("qa");
    const exp = await service.workflowExport(P, ORG, inst.instanceId);
    expect(exp.filename).toBe(`workflow-${inst.instanceId}.md`);
    expect(exp.markdown).toContain("# 工作流实例：测试项目");
    expect(exp.markdown).toContain("推进 响应文件 → 质量门");
    expect(exp.markdown).toContain("## 时间线");
  });

  it("audits every node: approval is recorded and required to leave", async () => {
    const { service } = h;
    const inst = await tenderInstance(h);
    const ok = await service.approveWorkflowInstance(
      P, ORG, inst.instanceId, { comment: "看过，可以走" }, ACTOR,
    );
    expect(ok.events.filter((e) => e.kind === "approved")).toHaveLength(1);
    const next = await service.advanceWorkflowInstance(P, ORG, inst.instanceId, {}, ACTOR);
    expect(next.currentStage).toBe("terms");
    // The approval was consumed by leaving: advancing again needs a fresh one.
    await expect(
      service.advanceWorkflowInstance(P, ORG, inst.instanceId, {}, ACTOR),
    ).rejects.toMatchObject({ code: "workflow_not_approved" });
  });

  it("upgrades definitions only forward and flags old instances", async () => {    const { service } = h;
    const inst = await tenderInstance(h);
    const v1 = await service.workflowDefinition(P, ORG, "bidding-v1");
    const seed = await fs.readFile(
      new URL("../src/organization/templates/bidding-v1.yaml", import.meta.url),
      "utf8",
    );
    // Same version: stale. Bad YAML: invalid. Wrong id: mismatch.
    await expect(
      service.writeWorkflowDefinition(P, ORG, "bidding-v1", { yaml: seed }),
    ).rejects.toMatchObject({ code: "workflow_version_stale" });
    await expect(service.writeWorkflowDefinition(P, ORG, "bidding-v1", { yaml: "not: [valid" })).rejects.toMatchObject({
      code: "workflow_invalid",
    });
    await expect(
      service.writeWorkflowDefinition(P, ORG, "other", { yaml: "id: bidding-v1\nversion: 9\nname: X\nstages:\n  - {key: alpha, name: A, ownerRole: R}\n" }),
    ).rejects.toMatchObject({ code: "workflow_id_mismatch" });
    // Forward: accepted, old instance flags the mismatch but keeps replaying.
    const yaml = [
      "id: bidding-v1",
      "version: 2",
      "name: 招投标交付流程",
      "description: v2",
      "bizKeyPrefix: term-",
      "stages:",
      ...v1.stages.map(
        (s) => `  - {key: ${s.key}, name: ${s.name}, ownerRole: ${s.ownerRole}}`,
      ),
    ].join("\n");
    const v2 = await service.writeWorkflowDefinition(P, ORG, "bidding-v1", { yaml });
    expect(v2.version).toBe(2);
    const defs = await service.workflowDefinitions(P, ORG);
    expect(defs.definitions.find((d) => d.id === "bidding-v1")?.historyVersions).toEqual([1]);
    const raw = await service.workflowDefinitionYaml(P, ORG, "bidding-v1");
    expect(raw.version).toBe(2);
    expect(raw.yaml).toContain("version: 2");
    await expect(
      service.writeWorkflowDefinition(P, ORG, "bidding-v1", {
        definition: { id: "bidding-v1", version: 2, name: "X", description: "", bizKeyPrefix: "", stages: [{ key: "aa", name: "A", ownerRole: "R", entries: [], exits: [] }] },
      }),
    ).rejects.toMatchObject({ code: "workflow_version_stale" });
    const detail = await service.workflowInstance(P, ORG, inst.instanceId);
    expect(detail.versionMismatch).toBe(true);
    expect(detail.definitionVersion).toBe(1);
    const next = await approveAndAdvance(h, inst.instanceId);
    expect(next.currentStage).toBe("terms");
  });

  it("answers digests on demand and posts one daily digest per active day", async () => {
    const { service, scheduler, clock } = h;
    const inst = await tenderInstance(h);
    await approveAndAdvance(h, inst.instanceId);
    // On demand: the active day renders, a quiet day is null.
    const hit = await service.workflowDigest(P, ORG, "2026-11-01");
    expect(hit.date).toBe("2026-11-01");
    expect(hit.markdown).toContain("【工作流日报 2026-11-01】");
    const miss = await service.workflowDigest(P, ORG, "2026-10-01");
    expect(miss.markdown).toBeNull();
    // Next day the tick posts yesterday's digest exactly once.
    clock.nowMs = T0 + 26 * 3_600_000;
    await scheduler.tickOnce();
    await scheduler.tickOnce();
    const texts = await channelTexts(h);
    const digests = texts.filter((t) => t.includes("【工作流日报 2026-11-01】"));
    expect(digests).toHaveLength(1);
  });
});

describe("workflow AI audit", () => {
  async function harnessWith(
    completeOnce:
      | ((projectId: string, prompt: string) => Promise<{ ok: true; text: string } | { ok: false; cause: "no_model" | "failed"; error: string }>)
      | undefined,
  ) {
    const hh = await makeOrgHarness({ nowMs: T0, ...(completeOnce !== undefined ? { completeOnce } : {}) });
    const { service } = hh;
    await service.create(P, { orgId: ORG, name: "TenderCo", mission: "把招标做完" }, "alice");
    const inst = await service.createWorkflowInstance(
      P,
      ORG,
      { definitionId: "bidding-v1", bizKey: "term-ai", title: "AI审核项目" },
      ACTOR,
    );
    return { hh, service, inst };
  }

  it("prompts with the stage, gates, tickets and history", async () => {
    let seen = "";
    const { service, inst } = await harnessWith(async (_p, prompt) => {
      seen = prompt;
      return { ok: true, text: '{"decision":"approve","reason":"行"}' };
    });
    await service.approveWorkflowInstance(P, ORG, inst.instanceId, { comment: "加急" }, ACTOR);
    expect(seen).toContain("线索抓取");
    expect(seen).toContain("加急");
    expect(seen).toContain("decision");
  });

  it("records rejections as 400 and failures as 502, never inventing verdicts", async () => {
    const rej = await harnessWith(async () => ({ ok: true, text: '{"decision":"reject","reason":"缺要点"}' }));
    await expect(
      rej.service.approveWorkflowInstance(P, ORG, rej.inst.instanceId, {}, ACTOR),
    ).rejects.toMatchObject({ code: "workflow_ai_rejected" });
    const garbage = await harnessWith(async () => ({ ok: true, text: "还行吧" }));
    await expect(
      garbage.service.approveWorkflowInstance(P, ORG, garbage.inst.instanceId, {}, ACTOR),
    ).rejects.toMatchObject({ code: "ai_unavailable" });
    const down = await harnessWith(async () => ({ ok: false, cause: "failed" as const, error: "timeout" }));
    await expect(
      down.service.approveWorkflowInstance(P, ORG, down.inst.instanceId, {}, ACTOR),
    ).rejects.toMatchObject({ code: "ai_unavailable" });
    const nomodel = await harnessWith(undefined);
    await expect(
      nomodel.service.approveWorkflowInstance(P, ORG, nomodel.inst.instanceId, {}, ACTOR),
    ).rejects.toMatchObject({ code: "ai_unavailable" });
  });

  it("takes human overrides with a comment, and refuses comment-less force", async () => {
    const { service, inst } = await harnessWith(undefined);
    await expect(
      service.approveWorkflowInstance(P, ORG, inst.instanceId, { force: true }, ACTOR),
    ).rejects.toMatchObject({ code: "workflow_force_needs_comment" });
    const next = await service.approveWorkflowInstance(
      P,
      ORG,
      inst.instanceId,
      { force: true, comment: "人工确认过" },
      ACTOR,
    );
    expect(next.events.filter((e) => e.kind === "approved")).toHaveLength(1);
    const advanced = await service.advanceWorkflowInstance(P, ORG, inst.instanceId, {}, ACTOR);
    expect(advanced.currentStage).toBe("terms");
  });
});
