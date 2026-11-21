-- Browser sessions (ADR 0007): the cookie holds a random session token, never the API key.
-- Only the token's SHA-256 is stored. WITHOUT ROWID: the primary key is the table, so each
-- sign-in writes one row. No member index: deleting a member's sessions (rotate/revoke) is rare
-- and the table is tiny (at most MAX_SESSIONS_PER_MEMBER rows per member).
CREATE TABLE sessions (
  token_hash  TEXT    PRIMARY KEY,
  member_id   INTEGER NOT NULL REFERENCES members(id),
  created_at  TEXT    NOT NULL,
  expires_at  TEXT    NOT NULL
) WITHOUT ROWID;
