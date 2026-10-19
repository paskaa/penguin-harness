/**
 * Per-run outcomes: one row per driven run — how it ended (completed | failed |
 * aborted) and the failure code. Written by the session manager at drive wrap-up
 * (model switches excluded — moves, not runs); read by run-based coordination to
 * come (autopilot run-failure rules) and by the session runs API. A retention sweep
 * is a follow-up; the rows are small.
 */
import type { DatabaseSync } from "node:sqlite";

export type RunOutcome = "completed" | "failed" | "aborted";

export interface RunOutcomeRow {
  id: number;
  projectId: string;
  agentId: string;
  sessionId: string;
  startedAt: string;
  endedAt: string;
  outcome: RunOutcome;
  errorCode: string | null;
}

export class RunOutcomesRepo {
  constructor(private readonly db: DatabaseSync) {}

  /** Records one finished run. */
  record(args: {
    projectId: string;
    agentId: string;
    sessionId: string;
    startedAt: string;
    endedAt: string;
    outcome: RunOutcome;
    errorCode?: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO run_outcomes (project_id, agent_id, session_id, started_at, ended_at, outcome, error_code)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        args.projectId,
        args.agentId,
        args.sessionId,
        args.startedAt,
        args.endedAt,
        args.outcome,
        args.errorCode ?? null,
      );
  }

  /** The latest runs of one session, newest first. */
  recentBySession(
    projectId: string,
    agentId: string,
    sessionId: string,
    limit: number,
  ): RunOutcomeRow[] {
    const rows = this.db
      .prepare(
        `SELECT id, project_id, agent_id, session_id, started_at, ended_at, outcome, error_code
         FROM run_outcomes WHERE project_id = ? AND agent_id = ? AND session_id = ?
         ORDER BY ended_at DESC, id DESC LIMIT ?`,
      )
      .all(projectId, agentId, sessionId, Math.max(1, Math.min(200, Math.floor(limit)))) as Record<
      string,
      unknown
    >[];
    return rows.map((r) => ({
      id: r.id as number,
      projectId: r.project_id as string,
      agentId: r.agent_id as string,
      sessionId: r.session_id as string,
      startedAt: r.started_at as string,
      endedAt: r.ended_at as string,
      outcome: r.outcome as RunOutcome,
      errorCode: (r.error_code as string | null) ?? null,
    }));
  }
}
