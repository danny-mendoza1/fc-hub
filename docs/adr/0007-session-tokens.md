# ADR 0007: Browser sessions use their own tokens

- **Status:** Accepted. Supersedes the "cookie holds the API key" part of ADR 0003's sign-in.
- **Date:** 2026-11-20

## Context

Signing in to the website traded the member's API key for an HttpOnly cookie that contained **the key itself**. The cookie was read-only on the server (uploads need the `Authorization` header), but anyone who got hold of it had the real key: they could upload as that member, from the plugin or curl, until an admin noticed. Signing out only deleted the browser's copy. And with key rotation (`POST /admin/members/:id/rotate-key`), there was no way to end the browser sessions that a leaked key had opened.

## Decision

- Sign-in checks the key and creates a **session**: 32 random bytes with an `fchs_` prefix, so it can never be mistaken for a key (`fch_`). The cookie holds the token, and the `sessions` table holds only its SHA-256, the member and an expiry 30 days out.
- Cookie authentication looks the token up, joined to an active (not revoked) member. It still only works on read routes.
- Sessions end on sign-out (the row is deleted, so a kept cookie stops working), on key rotation and on revocation (all of that member's sessions), and at expiry.
- Growth is bounded: each sign-in clears expired sessions and keeps the newest 10 per member.
- Sign-in and sign-out get their own route policy, `{ access: "public", writes: "session" }`, so "which routes can write" stays explicit (ADR 0005). Sign-in writes nothing unless the key checks out, and a test pins `/api/v1/session` as the only route with this policy.

## Consequences

- A stolen cookie can read for at most 30 days, can't upload, and is killed by signing out or rotating the key.
- One extra read per cookie-authenticated request (the session join) and one or two rows written per sign-in. Both are negligible next to uploads.
- **Deploy:** apply migration `0004_sessions.sql` before the code. Everyone signs in again once, because old cookies hold keys, which are no longer accepted as sessions.
