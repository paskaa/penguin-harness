/**
 * Per-Project per-model health memory for failover: consecutive transport-failure counts
 * (reset by any success) and manual quality-failure bans. A Project-local echo of tracker's
 * `ph_model_pool` failure memory (`MODEL_FAIL_THRESHOLD` / quality熔断), read by failover
 * target selection and written by request ends — switching models is the one thing it
 * decides, never the default or an explicit choice.
 *
 * Two memories, two writers: `noteRequestEnd` counts transport failures (429s, timeouts,
 * 5xx-as-`network`, transport drops) and resets on success; `noteQualityFailure` is manual
 * (API only in v1 — no automatic producer yet) and bans within its cooldown. A row lost
 * here only means the next failover round re-learns from zero.
 */
import type { DatabaseSync } from "node:sqlite";

/** Consecutive counted failures after which failover skips the model (tracker's MODEL_FAIL_THRESHOLD). */
export const MODEL_FAIL_THRESHOLD = 10;

/** Consecutive quality failures after which the model is banned for the cooldown (tracker's QUALITY_FAIL_THRESHOLD). */
export const QUALITY_FAIL_THRESHOLD = 3;

/** How long a quality ban lasts (tracker's ph_qfail_cooldown_sec default, in ms). */
export const QFAIL_COOLDOWN_MS = 24 * 60 * 60 * 1000;

/**
 * Error codes worth switching models over: the transport said no, not the request.
 * Config/content codes (`auth`, `invalid_input`, `malformed`, `unsupported`, `rejected`,
 * `image_rejected`) are deliberately absent — a model that refuses the request refuses it
 * on every model, so counting them would only burn the chain.
 */
export const COUNTED_ERROR_CODES: ReadonlySet<string> = new Set([
  "rate_limited",
  "timeout",
  "network",
  "connect_failed",
]);

export interface ModelHealthRow {
  provider: string;
  modelId: string;
  failures: number;
  lastError: string | null;
  lastFailureAt: string | null;
  qfailCount: number;
  qfailAt: string | null;
  qfailReason: string | null;
  /** True while the quality ban is in force (count reached within the cooldown). */
  qualityBanned: boolean;
}

function toRow(r: Record<string, unknown>, nowMs: number): ModelHealthRow {
  const qfailCount = r.qfail_count as number;
  const qfailAt = (r.qfail_at as string | null) ?? null;
  const banned =
    qfailCount >= QUALITY_FAIL_THRESHOLD &&
    qfailAt !== null &&
    nowMs - Date.parse(qfailAt) < QFAIL_COOLDOWN_MS;
  return {
    provider: r.provider as string,
    modelId: r.model_id as string,
    failures: r.failures as number,
    lastError: (r.last_error as string | null) ?? null,
    lastFailureAt: (r.last_failure_at as string | null) ?? null,
    qfailCount,
    qfailAt,
    qfailReason: (r.qfail_reason as string | null) ?? null,
    qualityBanned: banned,
  };
}

export class ModelHealthRepo {
  constructor(private readonly db: DatabaseSync) {}

  /**
   * Records one request end for the model that ran it: a success resets the consecutive
   * count (creating no row when there is nothing to forget), a counted failure increments
   * it, anything else leaves the memory alone.
   */
  noteRequestEnd(
    projectId: string,
    provider: string,
    modelId: string,
    errorCode: string | undefined,
    nowIso: string,
  ): void {
    if (errorCode === undefined) {
      this.db
        .prepare(
          "UPDATE model_health SET failures = 0, updated_at = ? WHERE project_id = ? AND provider = ? AND model_id = ?",
        )
        .run(nowIso, projectId, provider, modelId);
      return;
    }
    if (!COUNTED_ERROR_CODES.has(errorCode)) return;
    this.db
      .prepare(
        `INSERT INTO model_health (project_id, provider, model_id, failures, last_error, last_failure_at, updated_at)
         VALUES (?, ?, ?, 1, ?, ?, ?)
         ON CONFLICT(project_id, provider, model_id) DO UPDATE SET
           failures = model_health.failures + 1, last_error = ?, last_failure_at = ?, updated_at = ?`,
      )
      .run(projectId, provider, modelId, errorCode, nowIso, nowIso, errorCode, nowIso, nowIso);
  }

  /**
   * The models failover must skip, as `provider/modelId` keys (the same shape the
   * Session's tried-set carries, so the two union): failure counts at the threshold,
   * plus quality bans in force. Fail-open: an unparseable ban timestamp bans nothing.
   */
  skippedModels(projectId: string, nowMs: number): string[] {
    const rows = this.db
      .prepare(
        "SELECT provider, model_id, failures, qfail_count, qfail_at FROM model_health WHERE project_id = ?",
      )
      .all(projectId) as Record<string, unknown>[];
    const out: string[] = [];
    for (const r of rows) {
      const provider = r.provider as string;
      const modelId = r.model_id as string;
      if ((r.failures as number) >= MODEL_FAIL_THRESHOLD) {
        out.push(`${provider}/${modelId}`);
        continue;
      }
      const qfailAt = r.qfail_at as string | null;
      const banned =
        (r.qfail_count as number) >= QUALITY_FAIL_THRESHOLD &&
        qfailAt !== null &&
        !Number.isNaN(Date.parse(qfailAt)) &&
        nowMs - Date.parse(qfailAt) < QFAIL_COOLDOWN_MS;
      if (banned) out.push(`${provider}/${modelId}`);
    }
    return out;
  }

  /**
   * Records one manual quality failure ("this model answered badly"): the count rises,
   * and reaching the threshold bans the model for the cooldown. Answers the count and
   * whether the ban is now in force.
   */
  noteQualityFailure(
    projectId: string,
    provider: string,
    modelId: string,
    reason: string,
    nowIso: string,
  ): { count: number; banned: boolean } {
    this.db
      .prepare(
        `INSERT INTO model_health (project_id, provider, model_id, qfail_count, qfail_at, qfail_reason, updated_at)
         VALUES (?, ?, ?, 1, ?, ?, ?)
         ON CONFLICT(project_id, provider, model_id) DO UPDATE SET
           qfail_count = model_health.qfail_count + 1, qfail_at = ?, qfail_reason = ?, updated_at = ?`,
      )
      .run(projectId, provider, modelId, nowIso, reason, nowIso, nowIso, reason, nowIso);
    const row = this.db
      .prepare(
        "SELECT qfail_count FROM model_health WHERE project_id = ? AND provider = ? AND model_id = ?",
      )
      .get(projectId, provider, modelId) as { qfail_count: number };
    const count = row.qfail_count;
    return { count, banned: count >= QUALITY_FAIL_THRESHOLD };
  }

  /**
   * Forgets transport failures (one model, or the whole Project): quality bans are
   * untouched. Answers how many rows it reset.
   */
  clearFailures(projectId: string, provider?: string, modelId?: string): number {
    if (provider !== undefined && modelId !== undefined) {
      return Number(
        this.db
          .prepare(
            "UPDATE model_health SET failures = 0 WHERE project_id = ? AND provider = ? AND model_id = ? AND failures <> 0",
          )
          .run(projectId, provider, modelId).changes,
      );
    }
    return Number(
      this.db.prepare("UPDATE model_health SET failures = 0 WHERE project_id = ? AND failures <> 0").run(
        projectId,
      ).changes,
    );
  }

  /**
   * Lifts quality bans (one model, or the whole Project): transport counts are untouched.
   * Answers how many rows it reset.
   */
  clearQualityFailures(projectId: string, provider?: string, modelId?: string): number {
    const set = "SET qfail_count = 0, qfail_at = NULL, qfail_reason = NULL";
    if (provider !== undefined && modelId !== undefined) {
      return Number(
        this.db
          .prepare(
            `UPDATE model_health ${set} WHERE project_id = ? AND provider = ? AND model_id = ? AND qfail_count <> 0`,
          )
          .run(projectId, provider, modelId).changes,
      );
    }
    return Number(
      this.db.prepare(`UPDATE model_health ${set} WHERE project_id = ? AND qfail_count <> 0`).run(projectId)
        .changes,
    );
  }

  /** Every remembered model of the Project, bans resolved against `nowMs`. */
  list(projectId: string, nowMs: number): ModelHealthRow[] {
    const rows = this.db
      .prepare(
        "SELECT provider, model_id, failures, last_error, last_failure_at, qfail_count, qfail_at, qfail_reason FROM model_health WHERE project_id = ?",
      )
      .all(projectId) as Record<string, unknown>[];
    return rows.map((r) => toRow(r, nowMs));
  }
}
