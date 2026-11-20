-- Wondrous Tails: one journal per member (alts are ignored; the plugin picks the character).

CREATE TABLE wondrous_tails (
  member_id             INTEGER PRIMARY KEY REFERENCES members(id),
  content_id            TEXT    NOT NULL REFERENCES characters(content_id),
  has_journal           INTEGER NOT NULL,
  is_expired            INTEGER NOT NULL,
  expires_at            TEXT,             -- null when no journal is held
  second_chance_points  INTEGER NOT NULL,
  stickers_placed       INTEGER NOT NULL,
  slots                 TEXT    NOT NULL, -- JSON array of the 16 objectives
  captured_at           TEXT    NOT NULL,
  -- Set when a still-valid journal disappears between uploads: the player handed it in.
  turned_in_at          TEXT,
  turned_in_expires_at  TEXT
);
