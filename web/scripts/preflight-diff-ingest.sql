-- No-op check that D1 accepts the diff-ingest SQL (web/src/ingest.ts). Writes nothing.
-- Generated: keep in sync via test/ingest.test.ts. Run: npm run db:preflight:remote
WITH incoming AS (
    SELECT json_extract(value, '$[0]') AS item_id, json_extract(value, '$[1]') AS name, json_extract(value, '$[2]') AS icon_id, json_extract(value, '$[3]') AS quantity, json_extract(value, '$[4]') AS is_hq, json_extract(value, '$[5]') AS is_collectable, json_extract(value, '$[6]') AS container, json_extract(value, '$[7]') AS sorted_container, json_extract(value, '$[8]') AS sorted_slot, json_extract(value, '$[9]') AS location
    FROM json_each('[]')
  ),
  incoming_n AS (
    SELECT *, row_number() OVER (PARTITION BY item_id, name, icon_id, quantity, is_hq, is_collectable, container, sorted_container, sorted_slot, location) AS n FROM incoming
  ),
  current_n AS (
    SELECT rowid AS rid, item_id, name, icon_id, quantity, is_hq, is_collectable, container, sorted_container, sorted_slot, location, row_number() OVER (PARTITION BY item_id, name, icon_id, quantity, is_hq, is_collectable, container, sorted_container, sorted_slot, location ORDER BY rowid) AS n
    FROM items WHERE owner_id = '__preflight__' AND section = '__preflight__'
  )
  DELETE FROM items WHERE EXISTS (SELECT 1 FROM owner_sections held WHERE held.owner_id = '__preflight__' AND held.section = '__preflight__' AND held.captured_at = '__preflight__' AND held.reported_by = '__preflight__') AND rowid IN (
    SELECT c.rid FROM current_n c
    WHERE NOT EXISTS (SELECT 1 FROM incoming_n i WHERE i.item_id = c.item_id AND i.name = c.name AND i.icon_id = c.icon_id AND i.quantity = c.quantity AND i.is_hq = c.is_hq AND i.is_collectable = c.is_collectable AND i.container = c.container AND i.sorted_container = c.sorted_container AND i.sorted_slot = c.sorted_slot AND i.location = c.location AND i.n = c.n)
  );
WITH incoming AS (
    SELECT json_extract(value, '$[0]') AS item_id, json_extract(value, '$[1]') AS name, json_extract(value, '$[2]') AS icon_id, json_extract(value, '$[3]') AS quantity, json_extract(value, '$[4]') AS is_hq, json_extract(value, '$[5]') AS is_collectable, json_extract(value, '$[6]') AS container, json_extract(value, '$[7]') AS sorted_container, json_extract(value, '$[8]') AS sorted_slot, json_extract(value, '$[9]') AS location
    FROM json_each('[]')
  ),
  incoming_n AS (
    SELECT *, row_number() OVER (PARTITION BY item_id, name, icon_id, quantity, is_hq, is_collectable, container, sorted_container, sorted_slot, location) AS n FROM incoming
  ),
  current_n AS (
    SELECT rowid AS rid, item_id, name, icon_id, quantity, is_hq, is_collectable, container, sorted_container, sorted_slot, location, row_number() OVER (PARTITION BY item_id, name, icon_id, quantity, is_hq, is_collectable, container, sorted_container, sorted_slot, location ORDER BY rowid) AS n
    FROM items WHERE owner_id = '__preflight__' AND section = '__preflight__'
  )
  INSERT INTO items (owner_id, section, item_id, name, icon_id, quantity, is_hq, is_collectable, container, sorted_container, sorted_slot, location)
  SELECT '__preflight__', '__preflight__', i.item_id, i.name, i.icon_id, i.quantity, i.is_hq, i.is_collectable, i.container, i.sorted_container, i.sorted_slot, i.location
  FROM incoming_n i
  WHERE EXISTS (SELECT 1 FROM owner_sections held WHERE held.owner_id = '__preflight__' AND held.section = '__preflight__' AND held.captured_at = '__preflight__' AND held.reported_by = '__preflight__') AND NOT EXISTS (SELECT 1 FROM current_n c WHERE i.item_id = c.item_id AND i.name = c.name AND i.icon_id = c.icon_id AND i.quantity = c.quantity AND i.is_hq = c.is_hq AND i.is_collectable = c.is_collectable AND i.container = c.container AND i.sorted_container = c.sorted_container AND i.sorted_slot = c.sorted_slot AND i.location = c.location AND i.n = c.n);
