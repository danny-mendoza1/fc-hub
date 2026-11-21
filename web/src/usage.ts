import { type AuthedMember, writeBudgetOverrideOf } from "./auth.ts";
import type { SqlDatabase } from "./db/types.ts";
import type { Limits } from "./limits.ts";

/**
 * The daily write budget (ADR 0005): every upload's D1 rows written are added to `usage_daily`
 * per member per UTC day, and uploads are refused once the member or the whole site is over budget.
 */

export function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export function secondsUntilUtcMidnight(now: Date): number {
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(1, Math.ceil((midnight - now.getTime()) / 1000));
}

/** The member's budget today: an unexpired admin override, else the site default. */
export function memberBudget(member: AuthedMember, limits: Limits, now: Date): number {
  const override = member.writeBudgetOverride;
  if (override && (override.until === null || Date.parse(override.until) > now.getTime())) return override.rows;
  return limits.memberDailyWriteRows;
}

export type BudgetVerdict =
  | { ok: true }
  | { ok: false; reason: "disabled" | "member" | "site"; retryAfterSeconds: number; message: string };

/** One indexed read. Fails closed: if the ledger can't be read, the caller's error stops the upload. */
export async function checkWriteBudget(db: SqlDatabase, member: AuthedMember, limits: Limits, now: Date): Promise<BudgetVerdict> {
  if (!limits.writesEnabled) {
    return { ok: false, reason: "disabled", retryAfterSeconds: 3600, message: "Uploads are paused on the server (read-only mode)." };
  }
  const used = await db
    .prepare(
      `SELECT COALESCE(SUM(rows_written), 0) AS site,
              COALESCE(SUM(CASE WHEN member_id = ?2 THEN rows_written ELSE 0 END), 0) AS member
       FROM usage_daily WHERE day = ?1`,
    )
    .bind(utcDay(now), member.id)
    .first<{ site: number; member: number }>();

  const retryAfterSeconds = secondsUntilUtcMidnight(now);
  if ((used?.site ?? 0) >= limits.siteDailyWriteRows) {
    return { ok: false, reason: "site", retryAfterSeconds, message: "The site's daily upload budget is used up; uploads resume at 00:00 UTC." };
  }
  if ((used?.member ?? 0) >= memberBudget(member, limits, now)) {
    return { ok: false, reason: "member", retryAfterSeconds, message: "Your daily upload budget is used up; uploads resume at 00:00 UTC." };
  }
  return { ok: true };
}

/** Adds a request's rows to today's ledger (plus the ledger row itself). Nothing written, nothing recorded. */
export async function recordWrites(db: SqlDatabase, memberId: number, rowsWritten: number, now: Date): Promise<void> {
  if (rowsWritten <= 0) return;
  await db
    .prepare(
      `INSERT INTO usage_daily (day, member_id, rows_written, requests) VALUES (?1, ?2, ?3, 1)
       ON CONFLICT (day, member_id) DO UPDATE SET
         rows_written = usage_daily.rows_written + excluded.rows_written, requests = usage_daily.requests + 1`,
    )
    .bind(utcDay(now), memberId, rowsWritten + 1)
    .run();
}

export interface UsageReport {
  day: string;
  resetsInSeconds: number;
  limits: Limits;
  siteRowsWritten: number;
  members: {
    id: number;
    displayName: string;
    revoked: boolean;
    rowsWritten: number;
    requests: number;
    budget: number;
    override: { rows: number; until: string | null } | null;
  }[];
}

/** GET /api/v1/admin/usage: today's usage against the budgets. */
export async function usageReport(db: SqlDatabase, limits: Limits, now: Date): Promise<UsageReport> {
  const rows = await db
    .prepare(
      `SELECT m.id, m.display_name, m.revoked_at, m.write_budget_override, m.write_budget_override_until,
              COALESCE(u.rows_written, 0) AS rows_written, COALESCE(u.requests, 0) AS requests
       FROM members m LEFT JOIN usage_daily u ON u.member_id = m.id AND u.day = ?
       ORDER BY m.display_name COLLATE NOCASE`,
    )
    .bind(utcDay(now))
    .all<{
      id: number;
      display_name: string;
      revoked_at: string | null;
      write_budget_override: number | null;
      write_budget_override_until: string | null;
      rows_written: number;
      requests: number;
    }>();

  const members = rows.results.map((r) => {
    const member: AuthedMember = { id: r.id, displayName: r.display_name, writeBudgetOverride: writeBudgetOverrideOf(r) };
    return {
      id: r.id,
      displayName: r.display_name,
      revoked: r.revoked_at !== null,
      rowsWritten: r.rows_written,
      requests: r.requests,
      budget: memberBudget(member, limits, now),
      override: member.writeBudgetOverride,
    };
  });
  return {
    day: utcDay(now),
    resetsInSeconds: secondsUntilUtcMidnight(now),
    limits,
    siteRowsWritten: members.reduce((sum, m) => sum + m.rowsWritten, 0),
    members,
  };
}

/** PUT /api/v1/admin/members/:id/write-budget. `rows: null` clears the override. */
export async function setWriteBudgetOverride(db: SqlDatabase, memberId: number, rows: number | null, until: string | null): Promise<boolean> {
  const result = await db
    .prepare("UPDATE members SET write_budget_override = ?, write_budget_override_until = ? WHERE id = ?")
    .bind(rows, rows === null ? null : until, memberId)
    .run();
  return result.meta.changes > 0;
}
