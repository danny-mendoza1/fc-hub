-- FC Hub schema v1. Runs unchanged on Cloudflare D1 and on node:sqlite.

-- People in the FC who can upload. Each member gets one API key (stored hashed).
CREATE TABLE members (
  id            INTEGER PRIMARY KEY,
  display_name  TEXT    NOT NULL,
  key_hash      TEXT    NOT NULL UNIQUE,  -- hex SHA-256 of the API key
  created_at    TEXT    NOT NULL,
  revoked_at    TEXT
);

-- Game characters, claimed by the member whose key first uploaded them.
CREATE TABLE characters (
  content_id     TEXT    PRIMARY KEY,     -- 64-bit id as decimal string
  member_id      INTEGER NOT NULL REFERENCES members(id),
  name           TEXT    NOT NULL,
  home_world_id  INTEGER NOT NULL,
  home_world     TEXT,
  last_upload_at TEXT    NOT NULL
);

-- Anything that holds items: the character itself, retainers, the FC chest, houses.
-- FC chests and houses can be reported by several characters; the latest report wins.
CREATE TABLE owners (
  owner_id     TEXT PRIMARY KEY,
  kind         TEXT NOT NULL CHECK (kind IN ('character', 'retainer', 'freeCompany', 'housing', 'unknown')),
  name         TEXT,
  reported_by  TEXT NOT NULL REFERENCES characters(content_id),
  updated_at   TEXT NOT NULL
);

-- One row per (owner, section) so sections can be replaced independently, e.g. a retainer's
-- bags vs its market listings. Sections not included in an upload are left untouched.
CREATE TABLE owner_sections (
  owner_id     TEXT NOT NULL REFERENCES owners(owner_id) ON DELETE CASCADE,
  section      TEXT NOT NULL,
  captured_at  TEXT NOT NULL,
  reported_by  TEXT NOT NULL REFERENCES characters(content_id),
  item_count   INTEGER NOT NULL,
  PRIMARY KEY (owner_id, section)
);

CREATE TABLE items (
  owner_id          TEXT    NOT NULL,
  section           TEXT    NOT NULL,
  item_id           INTEGER NOT NULL,
  name              TEXT    NOT NULL,
  icon_id           INTEGER NOT NULL,
  quantity          INTEGER NOT NULL,
  is_hq             INTEGER NOT NULL,
  is_collectable    INTEGER NOT NULL,
  container         INTEGER NOT NULL,
  sorted_container  INTEGER NOT NULL,
  sorted_slot       INTEGER NOT NULL,
  location          TEXT    NOT NULL,
  FOREIGN KEY (owner_id, section) REFERENCES owner_sections(owner_id, section) ON DELETE CASCADE
);

CREATE INDEX items_by_owner_section ON items(owner_id, section);
CREATE INDEX items_by_item ON items(item_id);
CREATE INDEX characters_by_member ON characters(member_id);
CREATE INDEX owners_by_reporter ON owners(reported_by);
