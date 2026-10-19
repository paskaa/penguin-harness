/**
 * Squad object + leader dispatch (service layer), driven through the org harness: CRUD
 * validation, `squad:` owners, and the assignment hooks that wake the leader. Each case
 * pins the contract (`docs/company-squad-autopilot-contract.md`): the leader routes and
 * never implements, a `proposed` ticket parks without waking anyone, and archiving hands
 * the squad's tickets to the former leader.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { parseOrgTriggerMessage } from "@prismshadow/penguin-core/markers";
import { makeOrgHarness } from "./org-harness.js";
import type { OrgHarness } from "./org-harness.js";

const T0 = Date.parse("2026-10-19T00:00:00.000Z");
const P = "p1";
const ORG = "acme";
const CEO = "acme_ceo";
const DEV = "acme_dev";
const QA = "acme_qa";

describe("squads", () => {
  let h: OrgHarness;

  const startedTexts = (): string[] => h.started.map((s) => s.text);
  const dispatchesTo = (sessionId: string): string[] =>
    h.started.filter((s) => s.sessionId === sessionId).map((s) => s.text);

  beforeEach(async () => {
    h = await makeOrgHarness({ nowMs: T0 });
    await h.service.create(
      P,
      { orgId: ORG, name: "Acme", mission: "Ship the thing on time.", timezone: "Asia/Shanghai" },
      "alice",
    );
    await h.service.hire(P, ORG, { newAgent: { agentId: DEV }, title: "Developer", reportsTo: CEO });
    await h.service.hire(P, ORG, { newAgent: { agentId: QA }, title: "QA", reportsTo: CEO });
  });

  it("creates squads with the leader auto-joined, and validates members and roles", async () => {
    const squad = await h.service.createSquad(P, ORG, {
      id: "delivery",
      name: "Delivery",
      leader: DEV,
      members: [`agent:${QA}`],
      roles: { [`agent:${QA}`]: "regression" },
      instructions: "DB changes go past QA first.",
    });
    expect(squad).toMatchObject({
      id: "delivery",
      leader: `agent:${DEV}`,
      members: [`agent:${DEV}`, `agent:${QA}`],
      archived: false,
    });
    await expect(
      h.service.createSquad(P, ORG, { id: "Bad Id", name: "x", leader: DEV }),
    ).rejects.toThrow();
    await expect(
      h.service.createSquad(P, ORG, { id: "ghost", name: "x", leader: "agent:nobody" }),
    ).rejects.toThrow(/employee/);
    await expect(
      h.service.createSquad(P, ORG, {
        id: "typo",
        name: "x",
        leader: DEV,
        roles: { "agent:nobody": "does things" },
      }),
    ).rejects.toThrow(/outside the squad/);
    expect((await h.service.listSquads(P, ORG)).map((s) => s.id)).toEqual(["delivery"]);
  });

  it("refuses to remove the leader directly, and auto-joins a new one", async () => {
    await h.service.createSquad(P, ORG, { id: "delivery", name: "Delivery", leader: DEV });
    await expect(
      h.service.updateSquad(P, ORG, "delivery", { members: [`agent:${QA}`] }),
    ).rejects.toThrow(/another leader/);
    const moved = await h.service.updateSquad(P, ORG, "delivery", { leader: QA });
    expect(moved.leader).toBe(`agent:${QA}`);
    expect(moved.members).toEqual([`agent:${DEV}`, `agent:${QA}`]);
  });

  it("assigning a working ticket to a squad wakes the leader with the protocol", async () => {
    await h.service.createSquad(P, ORG, {
      id: "delivery",
      name: "Delivery",
      leader: DEV,
      members: [`agent:${QA}`],
      roles: { [`agent:${QA}`]: "regression" },
      instructions: "DB changes go past QA first.",
    });
    const actor = { userId: "alice" };
    const t = await h.service.createTicket(P, ORG, { title: "Ship it", goal: "the goal" }, actor);
    const parked = h.started.length;
    // Filing lands in `proposed`: parked, nobody wakes.
    await h.service.updateTicket(P, ORG, t.ticketId, { owner: "squad:delivery" }, actor);
    expect(h.started.length).toBe(parked);
    // The move out carries the dispatch.
    await h.service.moveTicket(P, ORG, t.ticketId, "in_progress", undefined, actor);
    const devDesks = h.started.filter((s) => s.text.includes("squad \"Delivery\""));
    expect(devDesks).toHaveLength(1);
    const body = devDesks[0]!.text;
    expect(body).toContain("Squad operating protocol");
    expect(body).toContain(`@agent:${QA}`);
    expect(body).toContain("regression");
    expect(body).toContain("DB changes go past QA first.");
    expect(body).toContain("Ship it");
    const parsed = parseOrgTriggerMessage(body);
    expect(parsed?.origin.kind).toBe("ticket_work");
    expect(parsed?.origin.ticket).toBe(t.ticketId);
  });

  it("assigning a working ticket directly to a squad dispatches at once", async () => {
    await h.service.createSquad(P, ORG, { id: "delivery", name: "Delivery", leader: DEV });
    const actor = { userId: "alice" };
    const t = await h.service.createTicket(P, ORG, { title: "Ship it" }, actor);
    await h.service.moveTicket(P, ORG, t.ticketId, "in_progress", undefined, actor);
    const before = h.started.length;
    await h.service.updateTicket(P, ORG, t.ticketId, { owner: "squad:delivery" }, actor);
    const fresh = h.started.slice(before);
    expect(fresh).toHaveLength(1);
    expect(fresh[0]!.text).toContain("squad \"Delivery\"");
    expect(fresh[0]!.text).toContain("Stop after dispatching");
    // Unknown and archived squads are not owners.
    await expect(
      h.service.updateTicket(P, ORG, t.ticketId, { owner: "squad:ghost" }, actor),
    ).rejects.toThrow(/unknown squad/);
    await h.service.archiveSquad(P, ORG, "delivery", actor);
    await expect(
      h.service.updateTicket(P, ORG, t.ticketId, { owner: "squad:delivery" }, actor),
    ).rejects.toThrow(/archived/);
  });

  it("archiving hands the squad's tickets to the former leader, with history", async () => {
    await h.service.createSquad(P, ORG, { id: "delivery", name: "Delivery", leader: DEV });
    const actor = { userId: "alice" };
    const t = await h.service.createTicket(
      P,
      ORG,
      { title: "Ship it", owner: "squad:delivery" },
      actor,
    );
    expect(t.owner).toBe("squad:delivery");
    const archived = await h.service.archiveSquad(P, ORG, "delivery", actor);
    expect(archived.archived).toBe(true);
    const after = await h.service.ticket(P, ORG, t.ticketId);
    expect(after.owner).toBe(`agent:${DEV}`);
    expect(after.history.at(-1)).toMatchObject({ action: "assigned" });
    expect(after.history.at(-1)?.note).toContain("squad delivery archived");
    // Twice is a no-op, and the archived squad leaves the writable set.
    await h.service.archiveSquad(P, ORG, "delivery", actor);
    await expect(h.service.updateSquad(P, ORG, "delivery", { name: "x" })).rejects.toThrow(/archived/);
    expect(dispatchesTo("never-ran")).toHaveLength(0);
    expect(startedTexts().join("\n")).not.toContain("squad \"Delivery\"");
  });
});
