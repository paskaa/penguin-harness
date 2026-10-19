import { describe, expect, it } from "vitest";
import { employeeNameProblem, employeeNames, findMentions } from "../src/organization/names.js";

const e = (agentId: string, name?: string) => ({
  agentId,
  ...(name !== undefined ? { name } : {}),
});

describe("employee names", () => {
  it("keeps a name nobody else has, and notes the id on every holder of a shared one", () => {
    const names = employeeNames(
      [e("acme_ceo", "老王"), e("acme_dev_a", "小明"), e("acme_dev_b", "小明"), e("acme_qa")],
      (id) => id,
    );
    expect(Object.fromEntries(names)).toEqual({
      acme_ceo: "老王",
      acme_dev_a: "小明 (acme_dev_a)",
      acme_dev_b: "小明 (acme_dev_b)",
      acme_qa: "acme_qa",
    });
  });

  it("falls back to the Agent's display name, which can collide like any other", () => {
    const names = employeeNames([e("a_one"), e("a_two", "Robin")], () => "Robin");
    expect([...names.values()]).toEqual(["Robin (a_one)", "Robin (a_two)"]);
  });

  it("never lets a name shadow what @ already means: another's id, a member, all", () => {
    const names = employeeNames(
      [e("a_one", "a_two"), e("a_two"), e("a_three", "all"), e("a_four", "alice")],
      (id) => id,
      new Set(["alice"]),
    );
    expect(Object.fromEntries(names)).toEqual({
      a_one: "a_two (a_one)",
      a_two: "a_two",
      a_three: "all (a_three)",
      a_four: "alice (a_four)",
    });
  });

  it("accepts any script and spaces, and refuses what would break a line or a mention", () => {
    expect(employeeNameProblem("小明")).toBeNull();
    expect(employeeNameProblem("Ada Lovelace")).toBeNull();
    expect(employeeNameProblem("   ")).not.toBeNull();
    expect(employeeNameProblem("a\nb")).not.toBeNull();
    expect(employeeNameProblem("x@y")).not.toBeNull();
    expect(employeeNameProblem("x".repeat(65))).not.toBeNull();
  });
});

describe("mentions", () => {
  const explicit = (kind: "agent" | "user" | "squad", id: string) =>
    (kind === "agent" && id === "acme_dev_a") ||
    (kind === "user" && id === "ann") ||
    (kind === "squad" && id === "delivery")
      ? `${kind}:${id}`
      : null;
  const found = (text: string) =>
    findMentions(text, explicit).map((m) => [text.slice(m.start, m.end), m.principal]);

  it("resolves the exact markdown forms for every kind, spanning the whole link", () => {
    expect(
      found("ping [@Dev A](mention://agent/acme_dev_a) and [@Ann](mention://user/ann)."),
    ).toEqual([
      ["[@Dev A](mention://agent/acme_dev_a)", "agent:acme_dev_a"],
      ["[@Ann](mention://user/ann)", "user:ann"],
    ]);
    expect(found("route to [@Squad](mention://squad/delivery) please")).toEqual([
      ["[@Squad](mention://squad/delivery)", "squad:delivery"],
    ]);
    expect(found("[@Everyone](mention://all) standup")).toEqual([
      ["[@Everyone](mention://all)", "all"],
    ]);
  });

  it("trusts the URL, never the label — and drops unknown or archived targets", () => {
    expect(found("[@Liar](mention://agent/acme_dev_a)")).toEqual([
      ["[@Liar](mention://agent/acme_dev_a)", "agent:acme_dev_a"],
    ]);
    expect(found("[@Ghost](mention://agent/ghost)")).toEqual([]);
    expect(found("[@Ghost](mention://squad/ghost)")).toEqual([]);
  });

  it("leaves every bare @ form as prose: ids, names, all, explicit prefixes", () => {
    expect(found("@acme_dev_a 看一下，@小明 也看一下")).toEqual([]);
    expect(found("(@ann) @all. thanks @ann.")).toEqual([]);
    expect(found("@agent:acme_dev_a and @squad:delivery and @user:ann")).toEqual([]);
    expect(found("mail me at bob@ann.example")).toEqual([]);
  });

  it("needs the @-label and the exact scheme: ordinary links never page", () => {
    expect(found("[Dev A](mention://agent/acme_dev_a)")).toEqual([]);
    expect(found("[@Dev A](mention://member/acme_dev_a)")).toEqual([]);
    expect(found("[@Dev A](https://example.com)")).toEqual([]);
    expect(found("[@Dev A](mention://agent/acme_dev_a")).toEqual([]);
  });
});
