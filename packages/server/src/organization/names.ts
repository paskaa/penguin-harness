/**
 * What an employee is called, and how a channel message addresses one.
 *
 * An employee has an id (the Agent's: ASCII, fixed, what files and commands use) and a NAME —
 * written in its chart entry, for people: any script, spaces allowed. The name is display:
 * chips, rosters and menus show it, but nothing is ADDRESSED by it. Addressing is exact,
 * Multica's shape with this server's principal spelling: only
 * `[@Label](mention://agent|user|squad/<id>)` — and `[@All](mention://all)` — names
 * someone, and the URL names them, never the label. A bare `@name`, `@id`, `@all` or
 * `@agent:<id>` in prose is inert text: it pages nobody, which is what keeps a sentence
 * about "@ceo" from waking the CEO.
 *
 * A name is the organization's to give, so it is the chart's field rather than the Agent's
 * display name (which stays the fallback for an entry that has none, then the id). Names need
 * not be unique as written: two employees called the same are told apart by the system, which
 * shows each as `name (id)`.
 */
import type { OrgEmployee } from "./files.js";

/** A name as written in the chart: one line, no `@`, at most this long. */
export const EMPLOYEE_NAME_MAX = 64;

/** Why `raw` cannot be an employee's name, or null when it can. */
export function employeeNameProblem(raw: string): string | null {
  const name = raw.trim();
  if (name === "") return "name must not be empty";
  if (name.length > EMPLOYEE_NAME_MAX) return `name is at most ${EMPLOYEE_NAME_MAX} characters`;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) return "name must be a single line";
  if (name.includes("@")) return "name must not contain @";
  return null;
}

/**
 * The name each employee goes by in this organization, unique across it. `fallback` answers
 * for an entry without a name of its own (the Agent's display name, else the id).
 *
 * A base name is kept bare only when it is nobody else's: not another employee's name, not
 * another employee's id, not a member's user id, not `all` — each of those would read
 * ambiguously beside it. Otherwise the id is appended as the note, and every holder of a
 * shared name gets one, so which of two 小明 keeps the bare form never depends on the
 * order of the chart.
 */
export function employeeNames(
  employees: readonly Pick<OrgEmployee, "agentId" | "name">[],
  fallback: (agentId: string) => string,
  reserved: ReadonlySet<string> = new Set(),
): Map<string, string> {
  const base = new Map<string, string>();
  for (const e of employees) base.set(e.agentId, e.name ?? fallback(e.agentId));
  const holders = new Map<string, number>();
  for (const name of base.values()) holders.set(name, (holders.get(name) ?? 0) + 1);
  const ids = new Set(employees.map((e) => e.agentId));
  const out = new Map<string, string>();
  for (const [agentId, name] of base) {
    const taken =
      (holders.get(name) ?? 0) > 1 ||
      name === "all" ||
      reserved.has(name) ||
      (ids.has(name) && name !== agentId);
    out.set(agentId, taken && name !== agentId ? `${name} (${agentId})` : name);
  }
  return out;
}

/** A mention found in a text: where it is (the whole markdown span) and whom it names. */
export interface MentionMatch {
  start: number;
  end: number;
  principal: string;
}

// `[@Label](mention://agent|user|squad/<id>)` and `[@Label](mention://all)`: the label
// must itself start with `@`, so an ordinary link can never page someone by accident.
// The id runs to the closing paren or whitespace, exact — no trailing-punctuation
// trimming, since punctuation lives outside the URL by construction.
const MENTION_MD =
  /\[(@[^\]\n]*)\]\(mention:\/\/(?:(agent|user|squad)\/([^)\s]+)|(all))\)/g;

/**
 * The mentions of a text: the exact markdown forms, resolved against what can be named.
 * `explicit` validates a kind/id pair against the live organization (an employee's id,
 * a member's user id, a live squad's id) and answers its principal, or null when the
 * pair names nothing — an unknown or archived target reads as text. `all` needs no
 * validation. The label is display only: a lying label still reaches the URL's owner.
 *
 * Nothing else mentions: a bare `@name`, `@id`, `@all` or `@agent:<id>` is prose, full
 * stop — that is what keeps "@ceo" in a sentence from paging the CEO.
 */
export function findMentions(
  text: string,
  explicit: (kind: "agent" | "user" | "squad", id: string) => string | null,
): MentionMatch[] {
  const out: MentionMatch[] = [];
  MENTION_MD.lastIndex = 0;
  for (let m = MENTION_MD.exec(text); m !== null; m = MENTION_MD.exec(text)) {
    if (m[4] === "all") {
      out.push({ start: m.index, end: m.index + m[0].length, principal: "all" });
      continue;
    }
    const principal = explicit(m[2] as "agent" | "user" | "squad", m[3]!);
    if (principal !== null) {
      out.push({ start: m.index, end: m.index + m[0].length, principal });
    }
  }
  return out;
}
