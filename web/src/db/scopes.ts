/**
 * Shared SQL for "data the website may show". A revoked member's characters, retainers and
 * uploads must disappear everywhere at once, so queries build on these instead of repeating the
 * filter (test/cost-guards.test.ts checks every read route for leaks).
 */

/** Condition on `members m`: the member's key hasn't been revoked. */
export const ACTIVE_MEMBER = "m.revoked_at IS NULL";

/**
 * Item rows with their section (s), owner (o), the character whose upload they came from (c) and
 * that character's active member (m). Add your own WHERE.
 */
export const FROM_ACTIVE_ITEMS = `FROM items i
  JOIN owner_sections s ON s.owner_id = i.owner_id AND s.section = i.section
  JOIN owners o ON o.owner_id = i.owner_id
  JOIN characters c ON c.content_id = s.reported_by
  JOIN members m ON m.id = c.member_id AND ${ACTIVE_MEMBER}`;
