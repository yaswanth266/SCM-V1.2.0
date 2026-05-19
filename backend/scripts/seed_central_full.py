"""Seed CENTRAL warehouse to the full PDF spec: 30 A-type + 30 B-type racks.
Idempotent — only inserts racks/bins that don't exist by code.

A-type rack: 5 levels (bins) per rack, capacity 300 KGS each, code CEN-M{n}
B-type rack: 3 levels (bins) per rack, capacity 300 KGS each, code CEN-E{n}

Run on server:
  cd /home/ubuntu/erp/backend
  source .env
  python3 scripts/seed_central_full.py
"""
import os
import pymysql

DB_HOST = os.environ.get('DB_HOST', 'localhost')
DB_USER = os.environ.get('DB_USER', 'root')
DB_PASS = os.environ.get('DB_PASSWORD', '')
DB_NAME = os.environ.get('DB_NAME', 'bhspl_scm')

A_TARGET = 30
B_TARGET = 30
A_LEVELS = 5
B_LEVELS = 3

conn = pymysql.connect(host=DB_HOST, user=DB_USER, password=DB_PASS, database=DB_NAME)
try:
    with conn.cursor() as cur:
        # Find the medicine aisle line (A racks live here)
        cur.execute("SELECT id FROM warehouse_lines WHERE code='CEN-F1-MED'")
        row = cur.fetchone()
        if not row:
            raise SystemExit('CEN-F1-MED line not found')
        med_line_id = row[0]

        cur.execute("SELECT id FROM warehouse_lines WHERE code='CEN-F2-EQUIP'")
        row = cur.fetchone()
        if not row:
            raise SystemExit('CEN-F2-EQUIP line not found')
        equip_line_id = row[0]

        # Existing A and B racks (count to skip)
        cur.execute("SELECT COUNT(*) FROM warehouse_racks WHERE line_id=%s AND rack_type='A'", (med_line_id,))
        existing_a = cur.fetchone()[0]
        cur.execute("SELECT COUNT(*) FROM warehouse_racks WHERE line_id=%s AND rack_type='B'", (equip_line_id,))
        existing_b = cur.fetchone()[0]

        added_racks = 0
        added_bins = 0

        # Add A racks up to target
        for n in range(existing_a + 1, A_TARGET + 1):
            code = f'CEN-M{n}'
            cur.execute("SELECT id FROM warehouse_racks WHERE code=%s", (code,))
            if cur.fetchone():
                continue
            cur.execute(
                "INSERT INTO warehouse_racks (line_id, code, name, levels, rack_type, is_active) "
                "VALUES (%s, %s, %s, %s, 'A', 1)",
                (med_line_id, code, f'Rack M{n} (A-Type, 5L)', A_LEVELS),
            )
            rack_id = cur.lastrowid
            added_racks += 1
            for level in range(1, A_LEVELS + 1):
                bin_code = f'{code}-L{level}'
                cur.execute(
                    "INSERT INTO warehouse_bins (rack_id, code, name, capacity, is_active) "
                    "VALUES (%s, %s, %s, %s, 1)",
                    (rack_id, bin_code, f'{code} Level {level}', 300),
                )
                added_bins += 1

        # Add B racks up to target
        for n in range(existing_b + 1, B_TARGET + 1):
            code = f'CEN-E{n}'
            cur.execute("SELECT id FROM warehouse_racks WHERE code=%s", (code,))
            if cur.fetchone():
                continue
            cur.execute(
                "INSERT INTO warehouse_racks (line_id, code, name, levels, rack_type, is_active) "
                "VALUES (%s, %s, %s, %s, 'B', 1)",
                (equip_line_id, code, f'Rack E{n} (B-Type, 3L)', B_LEVELS),
            )
            rack_id = cur.lastrowid
            added_racks += 1
            for level in range(1, B_LEVELS + 1):
                bin_code = f'{code}-L{level}'
                cur.execute(
                    "INSERT INTO warehouse_bins (rack_id, code, name, capacity, is_active) "
                    "VALUES (%s, %s, %s, %s, 1)",
                    (rack_id, bin_code, f'{code} Level {level}', 300),
                )
                added_bins += 1

        conn.commit()
        print(f'Added {added_racks} racks, {added_bins} bins')

        # Final state
        cur.execute(
            "SELECT rack_type, COUNT(*) FROM warehouse_racks "
            "WHERE line_id IN (%s, %s) GROUP BY rack_type ORDER BY rack_type",
            (med_line_id, equip_line_id),
        )
        for rt, c in cur.fetchall():
            print(f'  {rt}: {c} racks')
        cur.execute(
            "SELECT COUNT(*) FROM warehouse_bins b "
            "JOIN warehouse_racks r ON r.id=b.rack_id "
            "WHERE r.line_id IN (%s, %s)",
            (med_line_id, equip_line_id),
        )
        print(f'  total bins (med+equip aisles): {cur.fetchone()[0]}')
finally:
    conn.close()
