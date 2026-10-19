/**
 * Repo for schedule runtime state: intent and state are separate — the file is
 * declarative intent, this table only records runtime state such as
 * "fired before / last fired / missed / disabled" plus the creator.
 *
 * Identity rule: a change to `start_at` is treated as a new task instance
 * (registerOrSync resets the trigger state); a change to the file content fingerprint
 * only clears the disabled flag (the file becomes effective again after reconciliation).
 */
import { Component, Use } from "@prismshadow/penguin-core/kernel";
import type { Db } from "../../hmr/capabilities.js";
import type { Schedules } from "../../mechanisms/sessions.js";

export interface ScheduleStateRow {
  projectId: string;
  agentId: string;
  name: string;
  creatorUserId: string | null;
  startAtMs: number;
  defHash: string;
  lastSlotMs: number | null;
  lastFiredAt: string | null;
  firedOnce: boolean;
  missed: boolean;
  invalidReason: string | null;
  /** Consecutive firing failures (session creation / send); a success resets it. */
  failCount: number;
  /** Auto-pause instant after repeated failures; null = firing normally. */
  autoPausedAt: string | null;
  /** Why the auto-pause tripped (the firing-failure code). */
  autoPauseReason: string | null;
}

function mapRow(r: Record<string, unknown>): ScheduleStateRow {
  return {
    projectId: r.project_id as string,
    agentId: r.agent_id as string,
    name: r.name as string,
    creatorUserId: (r.creator_user_id as string | null) ?? null,
    startAtMs: Number(r.start_at_ms),
    defHash: r.def_hash as string,
    lastSlotMs: r.last_slot_ms === null ? null : Number(r.last_slot_ms),
    lastFiredAt: (r.last_fired_at as string | null) ?? null,
    firedOnce: Number(r.fired_once) === 1,
    missed: Number(r.missed) === 1,
    invalidReason: (r.invalid_reason as string | null) ?? null,
    failCount: Number(r.fail_count ?? 0),
    autoPausedAt: (r.auto_paused_at as string | null) ?? null,
    autoPauseReason: (r.auto_pause_reason as string | null) ?? null,
  };
}

@Component()
export class SchedulesRepo implements Schedules {
  @Use() private readonly db!: Db;

  find(projectId: string, agentId: string, name: string): ScheduleStateRow | null {
    const r = this.db
      .prepare("SELECT * FROM schedule_state WHERE project_id = ? AND agent_id = ? AND name = ?")
      .get(projectId, agentId, name);
    return r ? mapRow(r as Record<string, unknown>) : null;
  }

  listByAgent(projectId: string, agentId: string): ScheduleStateRow[] {
    const rows = this.db
      .prepare("SELECT * FROM schedule_state WHERE project_id = ? AND agent_id = ? ORDER BY name")
      .all(projectId, agentId);
    return rows.map((r) => mapRow(r as Record<string, unknown>));
  }

  /**
   * Register or sync a task's runtime state, returning the synced row plus a `fresh`
   * flag:
   * - Insert if it doesn't exist (creator is only persisted at this point; a hand-edited
   *   file gets registered via reconciliation, with creator falling back to the Project
   *   owner);
   * - A change to `start_at` resets the trigger state (a new task instance);
   * - Otherwise, a change to the file fingerprint only clears the disabled flag.
   * `fresh` = this call was an insert or reset — the scheduler only establishes its
   * "missed, don't backfill" baseline at this moment; afterward, last_slot being NULL
   * only means "no scheduled time has been consumed yet", and it must fire normally once
   * reached.
   */
  registerOrSync(args: {
    projectId: string;
    agentId: string;
    name: string;
    startAtMs: number;
    defHash: string;
    creatorUserId: string | null;
  }): { row: ScheduleStateRow; fresh: boolean } {
    const existing = this.find(args.projectId, args.agentId, args.name);
    let fresh = false;
    if (!existing) {
      this.db
        .prepare(
          `INSERT INTO schedule_state
             (project_id, agent_id, name, creator_user_id, start_at_ms, def_hash)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          args.projectId,
          args.agentId,
          args.name,
          args.creatorUserId,
          args.startAtMs,
          args.defHash,
        );
      fresh = true;
    } else if (existing.startAtMs !== args.startAtMs) {
      this.db
        .prepare(
          `UPDATE schedule_state
             SET start_at_ms = ?, def_hash = ?, last_slot_ms = NULL, last_fired_at = NULL,
                 fired_once = 0, missed = 0, invalid_reason = NULL,
                 fail_count = 0, auto_paused_at = NULL, auto_pause_reason = NULL
           WHERE project_id = ? AND agent_id = ? AND name = ?`,
        )
        .run(args.startAtMs, args.defHash, args.projectId, args.agentId, args.name);
      this.clearFirings(args.projectId, args.agentId, args.name);
      fresh = true;
    } else if (existing.defHash !== args.defHash) {
      this.db
        .prepare(
          `UPDATE schedule_state SET def_hash = ?, invalid_reason = NULL,
             fail_count = 0, auto_paused_at = NULL, auto_pause_reason = NULL
           WHERE project_id = ? AND agent_id = ? AND name = ?`,
        )
        .run(args.defHash, args.projectId, args.agentId, args.name);
      this.clearFirings(args.projectId, args.agentId, args.name);
    }
    const row = this.find(args.projectId, args.agentId, args.name);
    if (!row) throw new Error("Failed to read back schedule_state after registration");
    return { row, fresh };
  }

  /** Advance the consumed scheduled time (advances whether triggered or skipped; restarts don't re-trigger). */
  markSlot(projectId: string, agentId: string, name: string, slotMs: number): void {
    this.db
      .prepare(
        `UPDATE schedule_state SET last_slot_ms = ?
         WHERE project_id = ? AND agent_id = ? AND name = ?`,
      )
      .run(slotMs, projectId, agentId, name);
  }

  /** Record an actual send (also sets fired_once for a one-shot task). */
  markFired(
    projectId: string,
    agentId: string,
    name: string,
    firedAt: string,
    oneShot: boolean,
  ): void {
    this.db
      .prepare(
        `UPDATE schedule_state SET last_fired_at = ?, fired_once = CASE WHEN ? THEN 1 ELSE fired_once END
         WHERE project_id = ? AND agent_id = ? AND name = ?`,
      )
      .run(firedAt, oneShot ? 1 : 0, projectId, agentId, name);
  }

  /** Missed marker for a one-shot task (the scheduled time had already passed at startup/registration reconciliation; missed means not backfilled). */
  markMissed(projectId: string, agentId: string, name: string): void {
    this.db
      .prepare(
        `UPDATE schedule_state SET missed = 1
         WHERE project_id = ? AND agent_id = ? AND name = ?`,
      )
      .run(projectId, agentId, name);
  }

  /** Mark as disabled (e.g. the bound Session was deleted); cleared via registerOrSync after the file is modified. */
  markInvalid(projectId: string, agentId: string, name: string, reason: string): void {
    this.db
      .prepare(
        `UPDATE schedule_state SET invalid_reason = ?
         WHERE project_id = ? AND agent_id = ? AND name = ?`,
      )
      .run(reason, projectId, agentId, name);
  }

  /** One more consecutive firing failure; answers the new count. */
  noteFiringFailure(projectId: string, agentId: string, name: string): number {
    this.db
      .prepare(
        `UPDATE schedule_state SET fail_count = fail_count + 1
         WHERE project_id = ? AND agent_id = ? AND name = ?`,
      )
      .run(projectId, agentId, name);
    const row = this.db
      .prepare(
        "SELECT fail_count FROM schedule_state WHERE project_id = ? AND agent_id = ? AND name = ?",
      )
      .get(projectId, agentId, name) as { fail_count: number } | undefined;
    return row?.fail_count ?? 0;
  }

  /** A success resets the consecutive count (the pause itself needs an explicit resume). */
  noteFiringSuccess(projectId: string, agentId: string, name: string): void {
    this.db
      .prepare(
        `UPDATE schedule_state SET fail_count = 0
         WHERE project_id = ? AND agent_id = ? AND name = ?`,
      )
      .run(projectId, agentId, name);
  }

  /** Stops the ticks after repeated failures; resume (or a file edit) clears it. */
  autoPause(projectId: string, agentId: string, name: string, reason: string, at: string): void {
    this.db
      .prepare(
        `UPDATE schedule_state SET auto_paused_at = ?, auto_pause_reason = ?
         WHERE project_id = ? AND agent_id = ? AND name = ?`,
      )
      .run(at, reason, projectId, agentId, name);
  }

  /** Lifts an auto-pause and forgets the count behind it. */
  clearAutoPause(projectId: string, agentId: string, name: string): void {
    this.db
      .prepare(
        `UPDATE schedule_state SET fail_count = 0, auto_paused_at = NULL, auto_pause_reason = NULL
         WHERE project_id = ? AND agent_id = ? AND name = ?`,
      )
      .run(projectId, agentId, name);
    this.clearFirings(projectId, agentId, name);
  }

  /** Links one firing to the session it went to (scheduled and manual alike). */
  recordFiring(
    projectId: string,
    agentId: string,
    name: string,
    sessionId: string,
    firedAt: string,
    manual: boolean,
  ): void {
    this.db
      .prepare(
        `INSERT INTO schedule_firings (project_id, agent_id, name, session_id, fired_at, manual)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(projectId, agentId, name, sessionId, firedAt, manual ? 1 : 0);
  }

  /** Forgets a task's firing links (resume and file edits start the run-rule over). */
  clearFirings(projectId: string, agentId: string, name: string): void {
    this.db
      .prepare("DELETE FROM schedule_firings WHERE project_id = ? AND agent_id = ? AND name = ?")
      .run(projectId, agentId, name);
  }

  /**
   * One outcome per scheduled firing since `sinceIso`, oldest first: each firing's
   * outcome is its session's earliest run started at/after the fire (the fired task
   * starts synchronously, so the first run after the stamp is it). Firings with no
   * run yet read as nothing; manual firings never count (human-supervised).
   */
  firingOutcomes(
    projectId: string,
    agentId: string,
    name: string,
    sinceIso: string,
  ): Array<"completed" | "failed" | "aborted"> {
    const rows = this.db
      .prepare(
        `SELECT (SELECT o.outcome FROM run_outcomes o
                 WHERE o.project_id = f.project_id AND o.agent_id = f.agent_id
                   AND o.session_id = f.session_id AND o.started_at >= f.fired_at
                 ORDER BY o.started_at ASC, o.id ASC LIMIT 1) AS outcome
         FROM schedule_firings f
         WHERE f.project_id = ? AND f.agent_id = ? AND f.name = ?
           AND f.manual = 0 AND f.fired_at >= ?
         ORDER BY f.fired_at ASC`,
      )
      .all(projectId, agentId, name, sinceIso) as Array<{ outcome: string | null }>;
    return rows
      .map((r) => r.outcome)
      .filter(
        (o): o is "completed" | "failed" | "aborted" =>
          o === "completed" || o === "failed" || o === "aborted",
      );
  }

  /** Deleting the file removes the task: clears its runtime state. */
  delete(projectId: string, agentId: string, name: string): void {
    this.db
      .prepare("DELETE FROM schedule_state WHERE project_id = ? AND agent_id = ? AND name = ?")
      .run(projectId, agentId, name);
    this.clearFirings(projectId, agentId, name);
  }

  /** Reconciliation cleanup: deletes state rows under this Agent that aren't in the current file list, returning the removed names. */
  deleteMissing(projectId: string, agentId: string, presentNames: string[]): string[] {
    const rows = this.listByAgent(projectId, agentId);
    const present = new Set(presentNames);
    const removed: string[] = [];
    for (const row of rows) {
      if (!present.has(row.name)) {
        this.delete(projectId, agentId, row.name);
        removed.push(row.name);
      }
    }
    return removed;
  }

  deleteByAgent(projectId: string, agentId: string): void {
    this.db
      .prepare("DELETE FROM schedule_state WHERE project_id = ? AND agent_id = ?")
      .run(projectId, agentId);
    this.db
      .prepare("DELETE FROM schedule_firings WHERE project_id = ? AND agent_id = ?")
      .run(projectId, agentId);
  }

  deleteByProject(projectId: string): void {
    this.db.prepare("DELETE FROM schedule_state WHERE project_id = ?").run(projectId);
    this.db.prepare("DELETE FROM schedule_firings WHERE project_id = ?").run(projectId);
  }
}
