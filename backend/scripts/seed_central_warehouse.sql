-- 2026-05-06 — Seed CENTRAL warehouse storage hierarchy.
-- Based on the building floor plan + Smart Storage rack drawings:
--   A-Type rack (5 levels, 300kg/level)  — used for medicines
--   B-Type rack (3 levels, 300kg/level)  — used for medical equipment
-- We have 30 A-Type + 30 B-Type total in inventory; CENTRAL gets
-- 5 A + 3 B per the floor layout, leaves 25 A + 27 B for AP104/AP108.

SET FOREIGN_KEY_CHECKS = 0;

-- ─── Locations (floors) ─────────────────────────────────────────────
INSERT INTO warehouse_locations (warehouse_id, code, name, description, is_active)
VALUES
  (18, 'CEN-F1', '1st Floor — Medicines & Cold Storage', 'Medicines (5 racks) + Cold storage room', 1),
  (18, 'CEN-F2', '2nd Floor — Medical Equipment & Other', 'Medical equipment (3 racks) + general items', 1),
  (18, 'CEN-F3', '3rd Floor — Returns & High Value', 'Purchase returns + closed room for high-value', 1);

SET @loc_f1 := (SELECT id FROM warehouse_locations WHERE warehouse_id=18 AND code='CEN-F1');
SET @loc_f2 := (SELECT id FROM warehouse_locations WHERE warehouse_id=18 AND code='CEN-F2');
SET @loc_f3 := (SELECT id FROM warehouse_locations WHERE warehouse_id=18 AND code='CEN-F3');

-- ─── Lines (aisles / rooms within each floor) ───────────────────────
INSERT INTO warehouse_lines (location_id, code, name, zone_type, is_active)
VALUES
  (@loc_f1, 'CEN-F1-MED',   'Medicine Aisle',         'storage',  1),
  (@loc_f1, 'CEN-F1-COLD',  'Cold Storage Room',      'storage',  1),
  (@loc_f1, 'CEN-F1-DOCK',  'F1 Receiving Dock',      'receiving', 1),
  (@loc_f2, 'CEN-F2-EQUIP', 'Medical Equipment Aisle','storage',  1),
  (@loc_f2, 'CEN-F2-GEN',   'General Items Pallet',   'storage',  1),
  (@loc_f3, 'CEN-F3-RET',   'Purchase Returns Bay',   'returns',  1),
  (@loc_f3, 'CEN-F3-HV',    'High Value Vault',       'storage',  1);

SET @line_med   := (SELECT id FROM warehouse_lines WHERE code='CEN-F1-MED');
SET @line_cold  := (SELECT id FROM warehouse_lines WHERE code='CEN-F1-COLD');
SET @line_dock  := (SELECT id FROM warehouse_lines WHERE code='CEN-F1-DOCK');
SET @line_equip := (SELECT id FROM warehouse_lines WHERE code='CEN-F2-EQUIP');
SET @line_gen   := (SELECT id FROM warehouse_lines WHERE code='CEN-F2-GEN');
SET @line_ret   := (SELECT id FROM warehouse_lines WHERE code='CEN-F3-RET');
SET @line_hv    := (SELECT id FROM warehouse_lines WHERE code='CEN-F3-HV');

-- ─── Racks ──────────────────────────────────────────────────────────
-- 5 × A-Type (5 levels) on Medicine Aisle
INSERT INTO warehouse_racks (line_id, code, name, levels, is_active) VALUES
  (@line_med, 'CEN-M1', 'Rack M1 (A-Type, 5L)', 5, 1),
  (@line_med, 'CEN-M2', 'Rack M2 (A-Type, 5L)', 5, 1),
  (@line_med, 'CEN-M3', 'Rack M3 (A-Type, 5L)', 5, 1),
  (@line_med, 'CEN-M4', 'Rack M4 (A-Type, 5L)', 5, 1),
  (@line_med, 'CEN-M5', 'Rack M5 (A-Type, 5L)', 5, 1);

-- 3 × B-Type (3 levels) on Medical Equipment Aisle
INSERT INTO warehouse_racks (line_id, code, name, levels, is_active) VALUES
  (@line_equip, 'CEN-E1', 'Rack E1 (B-Type, 3L)', 3, 1),
  (@line_equip, 'CEN-E2', 'Rack E2 (B-Type, 3L)', 3, 1),
  (@line_equip, 'CEN-E3', 'Rack E3 (B-Type, 3L)', 3, 1);

-- Special-zone racks (single rack per zone for cold/general/returns/vault/dock)
INSERT INTO warehouse_racks (line_id, code, name, levels, is_active) VALUES
  (@line_cold, 'CEN-COLD-R1', 'Cold Storage Rack', 1, 1),
  (@line_dock, 'CEN-DOCK-R1', 'Receiving Dock',    1, 1),
  (@line_gen,  'CEN-GEN-R1',  'General Pallet',    1, 1),
  (@line_ret,  'CEN-RET-R1',  'Returns Holding',   1, 1),
  (@line_hv,   'CEN-HV-R1',   'High-Value Vault',  1, 1);

-- ─── Bins (one per level on the storage racks, plus single-bin for
--      special zones) ─────────────────────────────────────────────────
-- 5 medicine racks × 5 levels = 25 bins
INSERT INTO warehouse_bins (rack_id, code, name, bin_type, is_active)
SELECT r.id,
       CONCAT(r.code, '-L', n.lvl),
       CONCAT(r.name, ' Level ', n.lvl),
       'shelf', 1
FROM warehouse_racks r
CROSS JOIN (SELECT 1 lvl UNION SELECT 2 UNION SELECT 3 UNION SELECT 4 UNION SELECT 5) n
WHERE r.code IN ('CEN-M1','CEN-M2','CEN-M3','CEN-M4','CEN-M5');

-- 3 equipment racks × 3 levels = 9 bins
INSERT INTO warehouse_bins (rack_id, code, name, bin_type, is_active)
SELECT r.id,
       CONCAT(r.code, '-L', n.lvl),
       CONCAT(r.name, ' Level ', n.lvl),
       'shelf', 1
FROM warehouse_racks r
CROSS JOIN (SELECT 1 lvl UNION SELECT 2 UNION SELECT 3) n
WHERE r.code IN ('CEN-E1','CEN-E2','CEN-E3');

-- Special single-bin zones (cold, dock, general, returns, vault)
INSERT INTO warehouse_bins (rack_id, code, name, bin_type, is_active) VALUES
  ((SELECT id FROM warehouse_racks WHERE code='CEN-COLD-R1'), 'CEN-COLD-B1', 'Cold Storage Bin',    'shelf',  1),
  ((SELECT id FROM warehouse_racks WHERE code='CEN-DOCK-R1'), 'CEN-DOCK-B1', 'Receiving Floor',     'floor',  1),
  ((SELECT id FROM warehouse_racks WHERE code='CEN-GEN-R1'),  'CEN-GEN-B1',  'General Pallet Bin',  'pallet', 1),
  ((SELECT id FROM warehouse_racks WHERE code='CEN-RET-R1'),  'CEN-RET-B1',  'Returns Bin',         'shelf',  1),
  ((SELECT id FROM warehouse_racks WHERE code='CEN-HV-R1'),   'CEN-HV-B1',   'High-Value Bin',      'shelf',  1);

SET FOREIGN_KEY_CHECKS = 1;

-- Verify
SELECT 'LOCATIONS' m, COUNT(*) n FROM warehouse_locations WHERE warehouse_id=18
UNION ALL SELECT 'LINES', COUNT(*) FROM warehouse_lines wl JOIN warehouse_locations wloc ON wloc.id=wl.location_id WHERE wloc.warehouse_id=18
UNION ALL SELECT 'RACKS', COUNT(*) FROM warehouse_racks wr JOIN warehouse_lines wl ON wl.id=wr.line_id JOIN warehouse_locations wloc ON wloc.id=wl.location_id WHERE wloc.warehouse_id=18
UNION ALL SELECT 'BINS',  COUNT(*) FROM warehouse_bins wb JOIN warehouse_racks wr ON wr.id=wb.rack_id JOIN warehouse_lines wl ON wl.id=wr.line_id JOIN warehouse_locations wloc ON wloc.id=wl.location_id WHERE wloc.warehouse_id=18;
