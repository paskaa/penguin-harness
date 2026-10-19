/**
 * Per-user inbox row state: read + archived per (org, row key). Row keys mirror the
 * web's InboxRow keys (`mention/<id>`, `blocked/<ticket>`, `done/<ticket>`); archived
 * mentions carry a snapshot, since message lookup by id has no index (tickets resolve
 * live at read time instead).
 */
import type { DatabaseSync } from "node:sqlite";

export interface InboxRowState {
  read: boolean;
  archived: boolean;
}

export interface InboxArchivedRow {
  rowKey: string;
  snapshot: string | null;
  updatedAt: string;
}

export class InboxReadsRepo {
  constructor(private readonly db: DatabaseSync) {}

  /** Marks rows read/unread (upsert; untouched fields keep their values). */
  setRead(
    userId: string,
    projectId: string,
    orgId: string,
    keys: readonly string[],
    read: boolean,
    nowIso: string,
  ): void {
    for (const key of keys) {
      this.db
        .prepare(
          `INSERT INTO inbox_reads (user_id, project_id, org_id, row_key, is_read, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(user_id, project_id, org_id, row_key) DO UPDATE SET
             is_read = ?, updated_at = ?`,
        )
        .run(userId, projectId, orgId, key, read ? 1 : 0, nowIso, read ? 1 : 0, nowIso);
    }
  }

  /** Archives/unarchives rows (upsert; snapshots ride along for mentions). */
  setArchived(
    userId: string,
    projectId: string,
    orgId: string,
    rows: readonly { key: string; snapshot?: string }[],
    archived: boolean,
    nowIso: string,
  ): void {
    for (const row of rows) {
      this.db
        .prepare(
          `INSERT INTO inbox_reads (user_id, project_id, org_id, row_key, is_archived, snapshot, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(user_id, project_id, org_id, row_key) DO UPDATE SET
             is_archived = ?, snapshot = COALESCE(?, snapshot), updated_at = ?`,
        )
        .run(
          userId,
          projectId,
          orgId,
          row.key,
          archived ? 1 : 0,
          row.snapshot ?? null,
          nowIso,
          archived ? 1 : 0,
          row.snapshot ?? null,
          nowIso,
        );
    }
  }

  /** Every remembered row of the user's org inbox. */
  states(
    userId: string,
    projectId: string,
    orgId: string,
  ): Map<string, InboxRowState> {
    const rows = this.db
      .prepare(
        "SELECT row_key, is_read, is_archived FROM inbox_reads WHERE user_id = ? AND project_id = ? AND org_id = ?",
      )
      .all(userId, projectId, orgId) as Array<Record<string, unknown>>;
    const out = new Map<string, InboxRowState>();
    for (const r of rows) {
      out.set(r.row_key as string, {
        read: Number(r.is_read) === 1,
        archived: Number(r.is_archived) === 1,
      });
    }
    return out;
  }

  /** Archived rows, newest first (snapshots included for mentions). */
  archived(
    userId: string,
    projectId: string,
    orgId: string,
    limit: number,
  ): InboxArchivedRow[] {
    const rows = this.db
      .prepare(
        `SELECT row_key, snapshot, updated_at FROM inbox_reads
         WHERE user_id = ? AND project_id = ? AND org_id = ? AND is_archived = 1
         ORDER BY updated_at DESC LIMIT ?`,
      )
      .all(userId, projectId, orgId, Math.max(1, Math.min(200, Math.floor(limit)))) as Array<
      Record<string, unknown>
    >;
    return rows.map((r) => ({
      rowKey: r.row_key as string,
      snapshot: (r.snapshot as string | null) ?? null,
      updatedAt: r.updated_at as string,
    }));
  }
}
