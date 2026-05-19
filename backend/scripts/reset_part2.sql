SET FOREIGN_KEY_CHECKS = 0;

-- Cache test warehouse IDs
CREATE TEMPORARY TABLE _test_wh AS
SELECT id FROM warehouses
 WHERE name LIKE 'WH\_Auto\_%' OR name LIKE 'UpdatedWH\_%' OR name LIKE 'FullWH\_%';

-- Cache location/line/rack IDs in those test warehouses
CREATE TEMPORARY TABLE _test_loc AS
SELECT id FROM warehouse_locations WHERE warehouse_id IN (SELECT id FROM _test_wh);

CREATE TEMPORARY TABLE _test_line AS
SELECT id FROM warehouse_lines WHERE location_id IN (SELECT id FROM _test_loc);

CREATE TEMPORARY TABLE _test_rack AS
SELECT id FROM warehouse_racks WHERE line_id IN (SELECT id FROM _test_line);

-- Delete bins → racks → lines → locations → user_warehouses → warehouses
DELETE FROM warehouse_bins WHERE rack_id IN (SELECT id FROM _test_rack);
DELETE FROM warehouse_racks WHERE id IN (SELECT id FROM _test_rack);
DELETE FROM warehouse_lines WHERE id IN (SELECT id FROM _test_line);
DELETE FROM warehouse_locations WHERE id IN (SELECT id FROM _test_loc);
DELETE FROM user_warehouses WHERE warehouse_id IN (SELECT id FROM _test_wh);
DELETE FROM warehouses WHERE id IN (SELECT id FROM _test_wh);

-- Test items
DELETE FROM items WHERE name = 'Updated Item Name';

-- Tier 2: Uncategorized bucket
INSERT INTO item_categories (name, code, is_active, created_at)
SELECT 'Uncategorized', 'UNCAT', 1, NOW()
WHERE NOT EXISTS (SELECT 1 FROM item_categories WHERE code = 'UNCAT');

UPDATE items
   SET category_id = (SELECT id FROM item_categories WHERE code = 'UNCAT' LIMIT 1)
 WHERE category_id IS NULL;

SET FOREIGN_KEY_CHECKS = 1;

SELECT 'TEST_WHS_LEFT' m, COUNT(*) n FROM warehouses WHERE name LIKE 'WH\_Auto\_%' OR name LIKE 'UpdatedWH\_%' OR name LIKE 'FullWH\_%'
UNION ALL SELECT 'NULL_CAT_LEFT', COUNT(*) FROM items WHERE category_id IS NULL
UNION ALL SELECT 'TEST_ITEMS_LEFT', COUNT(*) FROM items WHERE name='Updated Item Name'
UNION ALL SELECT 'WAREHOUSES_NOW', COUNT(*) FROM warehouses
UNION ALL SELECT 'ITEMS_NOW', COUNT(*) FROM items
UNION ALL SELECT 'USERS_NOW', COUNT(*) FROM users
UNION ALL SELECT 'INDENTS_NOW', COUNT(*) FROM indents
UNION ALL SELECT 'STOCK_BAL_NOW', COUNT(*) FROM stock_balance;
