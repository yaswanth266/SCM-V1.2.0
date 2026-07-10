"""
Comprehensive Organisation Structure Re-Sync Script.

DROPs and re-CREATES tables (positions, employees, offices, projects) so the
schema matches the SQLAlchemy models exactly, then re-populates all data from
the HRMS external API. Captures ALL fields from the API and ensures BOTH
Position.employee_id AND Employee.position_id are set consistently.

Usage (server):
    cd /home/ubuntu/erp/backend
    python3 -m scripts.resync_org_structure

Usage (local):
    cd backend
    python -m scripts.resync_org_structure
"""

import asyncio
import sys
import os
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import httpx
from sqlalchemy import text

from app.config import settings
from app.database import engine, AsyncSessionLocal


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _text(row: dict, *keys, max_len=255):
    for key in keys:
        val = row
        for part in key.split("."):
            if not isinstance(val, dict):
                val = None
                break
            val = val.get(part)
        if val is not None and not isinstance(val, (dict, list)) and str(val).strip():
            return str(val).strip()[:max_len]
    return None


def _date(val):
    if not val:
        return None
    try:
        return str(val)[:10]
    except Exception:
        return None


def _int(val):
    if val is None:
        return None
    try:
        return int(val)
    except (TypeError, ValueError):
        return None


def _pos_base_url():
    base = settings.HR_EMPLOYEE_API_URL
    if "/api/employees" in base:
        return base.replace("/api/employees", "/api/positions")
    elif "/employees" in base:
        return base.replace("/employees", "/positions")
    return base.replace("employees", "positions")


def normalize_position_key(text_val: str) -> str:
    if not text_val:
        return ""
    import re
    # Convert to uppercase
    val = text_val.upper()
    # Replace symbols
    val = val.replace("@", "-").replace("_", "-").replace(" ", "-")
    # Split into words
    words = [w.strip() for w in val.split("-") if w.strip()]
    
    # Normalize roles
    has_district = "DISTRICT" in words
    has_manager = "MANAGER" in words
    has_regional = "REGIONAL" in words
    has_office = "OFFICE" in words
    has_executive = "EXECUTIVE" in words
    has_lab = "LAB" in words
    has_technician = "TECHNICIAN" in words
    has_store = "STORE" in words
    has_keeper = "KEEPER" in words
    has_state = "STATE" in words
    has_project = "PROJECT" in words
    has_head = "HEAD" in words
    
    # Reconstruct words list with normalized roles
    new_words = []
    # Check roles first
    if (has_district and has_manager) or "DM" in words:
        new_words.append("DM")
    elif (has_regional and has_manager) or "RM" in words:
        new_words.append("RM")
    elif (has_office and has_executive) or "OE" in words:
        new_words.append("OE")
    elif (has_lab and has_technician) or "LT" in words:
        new_words.append("LT")
    elif (has_store and has_keeper) or "STOREKEEPER" in words or "SK" in words:
        new_words.append("SK")
    elif (has_state and has_project and has_head) or "SPH" in words:
        new_words.append("SPH")
    
    # Filter words and add location parts
    filler = {
        "AP", "104", "MMU", "MMUS", "SERVICES", "MANAGER", "DISTRICT", "REGIONAL",
        "OFFICE", "EXECUTIVE", "LAB", "TECHNICIAN", "STORE", "KEEPER", "STOREKEEPER",
        "STATE", "PROJECT", "HEAD", "DM", "RM", "OE", "LT", "SK", "SPH", "CO", "COO"
    }
    
    # Spell correction map
    spellings = {
        "VIJAYWADA": "VIJAYAWADA",
        "CHITTO0R": "CHITTOOR",
        "TIRUPATHI": "TIRUPATI",
        "KANDUKUR": "KANDUKURU",
        "MARKAPUR": "MARKAPURAM",
    }
    
    for w in words:
        if w not in filler:
            corrected = spellings.get(w, w)
            new_words.append(corrected)
            
    return "-".join(new_words)


# ---------------------------------------------------------------------------
# Step 1 — DROP & re-CREATE tables
# ---------------------------------------------------------------------------

async def drop_and_recreate_tables():
    """DROP and re-CREATE tables so schema matches models exactly."""
    print("[1/5] Dropping and recreating tables...")
    from app.models.master import Office, Position, Employee
    from app.models.user import Project

    async with engine.connect() as conn:
        await conn.execute(text("SET FOREIGN_KEY_CHECKS = 0"))
        for table in ("positions", "employees", "offices", "projects"):
            await conn.execute(text(f"DROP TABLE IF EXISTS `{table}`"))
            print(f"  Dropped {table}")
        await conn.execute(text("SET FOREIGN_KEY_CHECKS = 1"))
        await conn.commit()

    async with engine.begin() as conn:
        await conn.execute(text("SET FOREIGN_KEY_CHECKS = 0"))
        await conn.run_sync(Project.__table__.create)
        await conn.run_sync(Office.__table__.create)
        await conn.run_sync(Position.__table__.create)
        await conn.run_sync(Employee.__table__.create)
        await conn.execute(text("SET FOREIGN_KEY_CHECKS = 1"))
        print("  Recreated all tables with current model schema")


# ---------------------------------------------------------------------------
# Step 2 — Fetch all data from HRMS API
# ---------------------------------------------------------------------------

async def _fetch_page(client, url, headers, page, label):
    for attempt in range(3):
        try:
            r = await client.get(url, headers=headers)
            r.raise_for_status()
            payload = r.json()
            return payload.get("results") or payload.get("items") or []
        except Exception as e:
            if attempt == 2:
                print(f"  Error fetching {label} page {page} (attempt {attempt+1}): {e}")
            await asyncio.sleep(0.5 * (attempt + 1))
    return []

async def _fetch_all_paginated(client, headers, base_url, label):
    print(f"  Fetching page 1 for {label}...")
    url = f"{base_url}?page_size=200&page=1"
    try:
        r = await client.get(url, headers=headers)
        r.raise_for_status()
        payload = r.json()
    except Exception as e:
        print(f"  Error fetching {label} page 1: {e}")
        return []

    first_page_items = payload.get("results") or payload.get("items") or []
    count = payload.get("count") or len(first_page_items)
    
    # Django REST Framework default page size (usually 10 or 20)
    page_size = len(first_page_items) if first_page_items else 10
    if page_size == 0:
        return []
        
    import math
    total_pages = math.ceil(count / page_size)
    print(f"  {label.capitalize()} total count: {count}, page size: {page_size}, total pages: {total_pages}")
    
    all_rows = list(first_page_items)
    if total_pages <= 1:
        return all_rows

    # Fetch other pages concurrently in batches of 10
    batch_size = 10
    tasks = []
    for page in range(2, total_pages + 1):
        url = f"{base_url}?page_size=200&page={page}"
        tasks.append((page, url))

    for i in range(0, len(tasks), batch_size):
        batch = tasks[i:i + batch_size]
        print(f"  Fetching {label} pages {batch[0][0]} to {batch[-1][0]} concurrently...")
        futures = [
            _fetch_page(client, url, headers, page, label)
            for page, url in batch
        ]
        results = await asyncio.gather(*futures)
        for items in results:
            all_rows.extend(items)
        await asyncio.sleep(0.05)

    return all_rows


async def fetch_all(client, headers):
    print("[2/5] Fetching employees from HRMS API...")
    employee_rows = await _fetch_all_paginated(client, headers,
                                               settings.HR_EMPLOYEE_API_URL,
                                               "employees")
    print(f"  Total: {len(employee_rows)} employees\n")

    print("[3/5] Fetching positions from HRMS API...")
    position_rows = await _fetch_all_paginated(client, headers,
                                               _pos_base_url(), "positions")
    print(f"  Total: {len(position_rows)} positions\n")
    return employee_rows, position_rows


# ---------------------------------------------------------------------------
# Step 4 — Sync data into the freshly created tables
# ---------------------------------------------------------------------------

async def sync_all(db, employee_rows, position_rows, org_id):
    print("[4/5] Syncing projects, offices, positions, employees...")
    stats = {"projects": 0, "offices": 0, "positions": 0, "employees": 0}
    created_parent_employees = set()

    # ---- PROJECTS ----
    project_map = {}
    for row in employee_rows:
        proj = row.get("project") or {}
        code = (_text(proj, "code") or "").upper()
        name = _text(proj, "name") or code
        if code and code not in project_map:
            existing = (await db.execute(
                text("SELECT id FROM projects WHERE code = :code"),
                {"code": code}
            )).scalar_one_or_none()
            if existing:
                project_map[code] = existing
            else:
                r = await db.execute(
                    text("""INSERT INTO projects (organization_id, name, code, status, created_at, updated_at)
                            VALUES (:org_id, :name, :code, 'active', NOW(), NOW())"""),
                    {"org_id": org_id, "name": name, "code": code}
                )
                project_map[code] = r.lastrowid
                stats["projects"] += 1
    await db.commit()
    print(f"  Projects: {stats['projects']} created, {len(project_map)} total")

    # ---- OFFICES ----
    office_map = {}
    for row in employee_rows:
        off = row.get("office") or {}
        name = _text(off, "name")
        if not name:
            continue
        key = name.lower().strip()
        if key in office_map:
            continue
        geo = off.get("geo_location") or {}
        existing = (await db.execute(
            text("SELECT id FROM offices WHERE LOWER(name) = :name LIMIT 1"),
            {"name": key}
        )).scalar()
        if existing:
            office_map[key] = existing
        else:
            r = await db.execute(
                text("""INSERT INTO offices (name, level, country, state, district, mandal,
                         cluster, cluster_type, specific_location, address,
                         created_at, updated_at)
                        VALUES (:name, :level, :country, :state, :district, :mandal,
                                :cluster, :cluster_type, :specific_location, :address,
                                NOW(), NOW())"""),
                {"name": name, "level": _text(off, "level"),
                 "country": _text(geo, "country"), "state": _text(geo, "state"),
                 "district": _text(geo, "district"), "mandal": _text(geo, "mandal"),
                 "cluster": _text(geo, "cluster"), "cluster_type": _text(geo, "cluster_type"),
                 "specific_location": _text(geo, "specific_location"),
                 "address": _text(geo, "address", max_len=2000)}
            )
            office_map[key] = r.lastrowid
            stats["offices"] += 1
    await db.commit()
    print(f"  Offices: {stats['offices']} created, {len(office_map)} total")

    # ---- POSITIONS (from employee data) ----
    position_map = {}
    parent_relations = []

    for row in employee_rows:
        pos = row.get("position") or {}
        code = (_text(pos, "code") or "").upper()
        name = _text(pos, "name")
        if not code or not name or code in position_map:
            continue

        project_code = (_text(row.get("project") or {}, "code") or "").upper()
        office_name = (_text(row.get("office") or {}, "name") or "").lower().strip()
        project_id = project_map.get(project_code)
        office_id = office_map.get(office_name)

        # Collect parent relationship to resolve later
        reporting_to = pos.get("reporting_to") or []
        if reporting_to and isinstance(reporting_to, list) and len(reporting_to) > 0:
            rt = reporting_to[0]
            if isinstance(rt, dict):
                import re
                parent_name = rt.get("position_name") or rt.get("name") or ""
                parent_code = rt.get("code") or rt.get("position_code")
                if not parent_code and parent_name:
                    parent_code = re.sub(r"[^a-zA-Z0-9]+", "-", parent_name).strip("-").upper()
                else:
                    parent_code = (parent_code or "").upper()
                
                if parent_code or parent_name:
                    parent_relations.append({
                        "child_code": code,
                        "parent_code": parent_code,
                        "parent_name": parent_name,
                        "parent_details": rt
                    })

        existing = (await db.execute(
            text("SELECT id FROM positions WHERE code = :code LIMIT 1"),
            {"code": code}
        )).scalar()

        if existing:
            position_map[code] = existing
        else:
            role_details = pos.get("role_details") or {}
            try:
                r = await db.execute(
                    text("""INSERT INTO positions
                        (name, code, role_name, role_id, level_name, level_rank,
                         department, section, job_name, job_family_name, job_family_id,
                         role_type_id, status, start_date, project_id, office_id,
                         created_at, updated_at)
                        VALUES (:name, :code, :role_name, :role_id, :level_name, :level_rank,
                                :department, :section, :job_name, :job_family_name, :job_family_id,
                                :role_type_id, :status, :start_date, :project_id, :office_id,
                                NOW(), NOW())"""),
                    {"name": name, "code": code,
                     "role_name": _text(pos, "role_name") or _text(role_details, "name"),
                     "role_id": _int(pos.get("role_id")) or _int(role_details.get("id")),
                     "level_name": _text(pos, "level_name") or _text(pos, "level"),
                     "level_rank": _int(pos.get("level_rank")),
                     "department": _text(pos, "department") or _text(row, "department"),
                     "section": _text(pos, "section"),
                     "job_name": _text(pos, "job_name") or _text(role_details, "job_name"),
                     "job_family_name": _text(pos, "job_family_name"),
                     "job_family_id": _int(pos.get("job_family_id")),
                     "role_type_id": _int(pos.get("role_type_id")),
                     "status": _text(pos, "status") or "active",
                     "start_date": _date(pos.get("start_date")),
                     "project_id": project_id, "office_id": office_id}
                )
                position_map[code] = r.lastrowid
                stats["positions"] += 1
            except Exception as e:
                print(f"  WARN: Could not create position {code}: {e}")

    # Positions from positions API for missed ones
    for pos_row in position_rows:
        code = (_text(pos_row, "code") or "").upper()
        if not code:
            continue
        
        # Collect parent relationship to resolve later
        reporting_to = pos_row.get("reporting_to") or []
        if reporting_to and isinstance(reporting_to, list) and len(reporting_to) > 0:
            rt = reporting_to[0]
            if isinstance(rt, dict):
                import re
                parent_name = rt.get("position_name") or rt.get("name") or ""
                parent_code = rt.get("code") or rt.get("position_code")
                if not parent_code and parent_name:
                    parent_code = re.sub(r"[^a-zA-Z0-9]+", "-", parent_name).strip("-").upper()
                else:
                    parent_code = (parent_code or "").upper()
                
                if parent_code or parent_name:
                    parent_relations.append({
                        "child_code": code,
                        "parent_code": parent_code,
                        "parent_name": parent_name,
                        "parent_details": rt
                    })

        if code in position_map:
            continue
            
        name = _text(pos_row, "name") or code
        role_details = pos_row.get("role_details") or {}
        try:
            r = await db.execute(
                text("""INSERT INTO positions
                    (name, code, role_name, role_id, level_name, level_rank,
                     department, section, job_name, job_family_name, job_family_id,
                     role_type_id, status, start_date, created_at, updated_at)
                    VALUES (:name, :code, :role_name, :role_id, :level_name, :level_rank,
                            :department, :section, :job_name, :job_family_name, :job_family_id,
                            :role_type_id, :status, :start_date, NOW(), NOW())"""),
                {"name": name, "code": code,
                 "role_name": _text(pos_row, "role_name") or _text(role_details, "name"),
                 "role_id": _int(pos_row.get("role_id")) or _int(role_details.get("id")),
                 "level_name": _text(pos_row, "level_name") or _text(pos_row, "level"),
                 "level_rank": _int(pos_row.get("level_rank")),
                 "department": _text(pos_row, "department_name") or _text(pos_row, "department"),
                 "section": _text(pos_row, "section_name") or _text(pos_row, "section"),
                 "job_name": _text(pos_row, "job_name") or _text(role_details, "job_name"),
                 "job_family_name": _text(pos_row, "job_family_name"),
                 "job_family_id": _int(pos_row.get("job_family_id")),
                 "role_type_id": _int(pos_row.get("role_type_id")),
                 "status": _text(pos_row, "status") or "active",
                 "start_date": _date(pos_row.get("start_date"))}
            )
            position_map[code] = r.lastrowid
            stats["positions"] += 1
        except Exception as e:
            print(f"  WARN: Could not insert position {code}: {e}")

    await db.commit()

    # ---- HIERARCHY RESOLUTION AND LINKING (Pass 2) ----
    print("  Resolving position hierarchy using normalized key matching...")
    normalized_to_id = {}
    for pos_code, db_id in position_map.items():
        norm_key = normalize_position_key(pos_code)
        if norm_key:
            normalized_to_id[norm_key] = db_id

    for rel in parent_relations:
        child_code = rel["child_code"]
        parent_code = rel["parent_code"]
        parent_name = rel["parent_name"]
        rt = rel["parent_details"]

        child_id = position_map.get(child_code)
        if not child_id:
            continue

        parent_id = None

        # 1. Try exact code match in position_map
        if parent_code:
            parent_id = position_map.get(parent_code)

        # 2. Try normalized match by parent_code
        if not parent_id and parent_code:
            norm_parent_code = normalize_position_key(parent_code)
            parent_id = normalized_to_id.get(norm_parent_code)

        # 3. Try normalized match by parent_name
        if not parent_id and parent_name:
            norm_parent_name = normalize_position_key(parent_name)
            parent_id = normalized_to_id.get(norm_parent_name)

        # 4. Fallback: Create parent stub position if genuinely missing
        if not parent_id:
            print(f"  Parent not found for {child_code} (Parent name: '{parent_name}', code: '{parent_code}'). Creating stub...")
            
            # Ensure parent office exists
            parent_office_id = _int(rt.get("office_id"))
            parent_office_name = rt.get("office_name")
            if parent_office_id or parent_office_name:
                off_exists = None
                if parent_office_id:
                    off_exists = (await db.execute(
                        text("SELECT id FROM offices WHERE id = :oid LIMIT 1"),
                        {"oid": parent_office_id}
                    )).scalar()
                if not off_exists and parent_office_name:
                    off_exists = (await db.execute(
                        text("SELECT id FROM offices WHERE LOWER(name) = :name LIMIT 1"),
                        {"name": parent_office_name.lower().strip()}
                    )).scalar()
                
                if not off_exists:
                    print(f"  Creating parent office: {parent_office_name} (ID: {parent_office_id})")
                    r_off = await db.execute(
                        text("""INSERT INTO offices
                                (id, name, level, created_at, updated_at)
                                VALUES (:id, :name, :level, NOW(), NOW())"""),
                        {"id": parent_office_id, "name": parent_office_name, "level": rt.get("office_level") or "CIRCLE OFFICE"}
                    )
                    parent_office_id = parent_office_id or r_off.lastrowid
                    office_map[parent_office_name.lower().strip()] = parent_office_id
                else:
                    parent_office_id = off_exists
            else:
                parent_office_id = None

            role_name = rt.get("role_name")
            role_id = None
            if role_name:
                role_id = (await db.execute(
                    text("SELECT id FROM roles WHERE LOWER(name) = :name AND is_active = 1 LIMIT 1"),
                    {"name": role_name.lower()}
                )).scalar()

            r_parent = await db.execute(
                text("""INSERT INTO positions
                        (name, code, role_name, role_id, level_name, level_rank,
                         department, section, office_id, status, created_at, updated_at)
                        VALUES (:name, :code, :role_name, :role_id, :level_name, :level_rank,
                                :department, :section, :office_id, 'active', NOW(), NOW())"""),
                {"name": parent_name, "code": parent_code or f"STUB-{normalize_position_key(parent_name)}", "role_name": role_name, "role_id": role_id,
                 "level_name": rt.get("level_name"), "level_rank": _int(rt.get("level_rank")),
                 "department": rt.get("department"), "section": rt.get("section"), "office_id": parent_office_id}
            )
            parent_id = r_parent.lastrowid
            
            if parent_code:
                position_map[parent_code] = parent_id
            else:
                position_map[f"STUB-{normalize_position_key(parent_name)}"] = parent_id
                
            norm_key = normalize_position_key(parent_code or parent_name)
            if norm_key:
                normalized_to_id[norm_key] = parent_id
                
            stats["positions"] += 1

            # Create parent employee if not exists
            parent_emp_id = _int(rt.get("employee_id"))
            if parent_emp_id:
                if parent_emp_id in created_parent_employees:
                    emp_exists = True
                else:
                    emp_exists = (await db.execute(
                        text("SELECT id FROM employees WHERE id = :eid LIMIT 1"),
                        {"eid": parent_emp_id}
                    )).scalar()
                
                if not emp_exists:
                    created_parent_employees.add(parent_emp_id)
                    emp_name = rt.get("employee_name") or parent_name
                    emp_code = f"HR-EMP-{parent_emp_id}"
                    await db.execute(
                        text("""INSERT IGNORE INTO employees
                                (id, employee_code, name, status, position_id, created_at, updated_at)
                                VALUES (:id, :code, :name, 'Active', :pos_id, NOW(), NOW())"""),
                        {"id": parent_emp_id, "code": emp_code, "name": emp_name, "pos_id": parent_id}
                    )
                    actual_emp_id = (await db.execute(
                        text("SELECT id FROM employees WHERE employee_code = :code LIMIT 1"),
                        {"code": emp_code}
                    )).scalar() or parent_emp_id
                    await db.execute(
                        text("UPDATE positions SET employee_id = :eid WHERE id = :pid"),
                        {"eid": actual_emp_id, "pid": parent_id}
                    )
                else:
                    emp_code = f"HR-EMP-{parent_emp_id}"
                    actual_emp_id = (await db.execute(
                        text("SELECT id FROM employees WHERE employee_code = :code LIMIT 1"),
                        {"code": emp_code}
                    )).scalar() or parent_emp_id
                    await db.execute(
                        text("UPDATE positions SET employee_id = :eid WHERE id = :pid AND employee_id IS NULL"),
                        {"eid": actual_emp_id, "pid": parent_id}
                    )

        if parent_id and child_id != parent_id:
            try:
                await db.execute(
                    text("UPDATE positions SET parent_position_id = :pid WHERE id = :cid AND parent_position_id IS NULL"),
                    {"cid": child_id, "pid": parent_id}
                )
            except Exception as e:
                print(f"  WARN: Failed to link child {child_code} to parent {parent_id}: {e}")

    await db.commit()
    print(f"  Positions: {stats['positions']} created, {len(position_map)} total")

    # ---- EMPLOYEES (bidirectional mapping) ----
    for row in employee_rows:
        emp = row.get("employee") or {}
        code = (_text(emp, "employee_code") or _text(row, "employee_code")
                or _text(emp, "code") or "")
        name = _text(emp, "name") or _text(row, "name") or code
        if not code:
            continue

        pos_data = row.get("position") or {}
        pos_code = (_text(pos_data, "code") or "").upper()
        position_id = position_map.get(pos_code)

        existing = (await db.execute(
            text("SELECT id FROM employees WHERE employee_code = :code LIMIT 1"),
            {"code": code}
        )).scalar()

        if not existing:
            try:
                emp_id = _int(row.get("id")) or _int(row.get("employee_id")) or _int(emp.get("id"))
                r = await db.execute(
                    text("""INSERT INTO employees
                        (id, employee_code, name, photo, status, dob, gender,
                         pan_number, aadhaar_number, email, phone,
                         hire_date, bank_details, position_id, created_at, updated_at)
                        VALUES (:id, :code, :name, :photo, :status, :dob, :gender,
                                :pan, :aadhaar, :email, :phone,
                                :hired, :bank_details, :pos_id, NOW(), NOW())"""),
                    {"id": emp_id, "code": code, "name": name,
                     "photo": _text(emp, "photo"),
                     "status": _text(emp, "status") or "Active",
                     "dob": _date(emp.get("dob")),
                     "gender": _text(emp, "gender"),
                     "pan": _text(emp, "pan_number"),
                     "aadhaar": _text(emp, "aadhaar_number"),
                     "email": _text(emp, "email"),
                     "phone": _text(emp, "phone"),
                     "hired": _date(row.get("hire_date")),
                     "bank_details": row.get("bank_details"),
                     "pos_id": position_id}
                )
                emp_id = emp_id or r.lastrowid
                stats["employees"] += 1

                if position_id and emp_id:
                    await db.execute(
                        text("UPDATE positions SET employee_id = :eid WHERE id = :pid AND employee_id IS NULL"),
                        {"pid": position_id, "eid": emp_id}
                    )
            except Exception as e:
                print(f"  WARN: Could not create employee {code}: {e}")
        else:
            emp_id = existing
            try:
                await db.execute(
                    text("""UPDATE employees SET name=:name, photo=:photo, status=:status,
                            dob=:dob, gender=:gender, pan_number=:pan, aadhaar_number=:aadhaar,
                            email=:email, phone=:phone, position_id=:pos_id, updated_at=NOW()
                            WHERE id=:id"""),
                    {"id": emp_id, "name": name, "photo": _text(emp, "photo"),
                     "status": _text(emp, "status") or "Active",
                     "dob": _date(emp.get("dob")), "gender": _text(emp, "gender"),
                     "pan": _text(emp, "pan_number"), "aadhaar": _text(emp, "aadhaar_number"),
                     "email": _text(emp, "email"), "phone": _text(emp, "phone"),
                     "pos_id": position_id}
                )
            except Exception as e:
                print(f"  WARN: Could not update employee {code}: {e}")

    await db.commit()

    # Populate employees.position_id for parent employees who were created with NULL position_id
    try:
        await db.execute(text("""
            UPDATE employees e
            JOIN (
                SELECT p.employee_id, MIN(p.id) as min_pos_id
                FROM positions p
                WHERE p.employee_id IS NOT NULL
                GROUP BY p.employee_id
            ) t ON e.id = t.employee_id
            SET e.position_id = t.min_pos_id
            WHERE e.position_id IS NULL
        """))
        await db.commit()
    except Exception as e:
        print(f"  WARN: Could not populate employees.position_id: {e}")

    # Step 5 — Assigned employee from positions API
    print("\n[5/5] Applying assigned_employee from positions API...")
    mapped = 0
    for pos_row in position_rows:
        code = (_text(pos_row, "code") or "").upper()
        if not code:
            continue
        assigned = pos_row.get("assigned_employee")
        if not assigned or not isinstance(assigned, dict):
            continue
        emp_id = _int(assigned.get("id"))
        if not emp_id:
            continue
        pos_id = position_map.get(code)
        if not pos_id:
            continue
        try:
            await db.execute(
                text("UPDATE positions SET employee_id = :eid WHERE id = :pid"),
                {"pid": pos_id, "eid": emp_id}
            )
            mapped += 1
        except Exception:
            pass
    await db.commit()
    print(f"  Mapped {mapped} positions via assigned_employee.\n")

    # Sync warehouses and link users (same as background webhook sync does)
    try:
        from app.services.office_warehouse_sync import sync_all_offices_to_warehouses
        from app.services.employee_warehouse_sync import sync_all_position_employees
        from app.api.v1.users import _link_users_to_employees, _apply_position_roles_to_linked_users
        
        print("Syncing offices to SCM warehouses...")
        await sync_all_offices_to_warehouses(db, organization_id=org_id or 1)
        print("Syncing employees to SCM warehouses...")
        await sync_all_position_employees(db)
        print("Linking users to employees...")
        linked_users = await _link_users_to_employees(db)
        print(f"  Linked {linked_users} users.")
        print("Applying position roles to users...")
        applied_roles = await _apply_position_roles_to_linked_users(db)
        print(f"  Applied roles to {applied_roles} users.")
        await db.commit()
    except Exception as e:
        print(f"  WARN: Error during post-sync warehousing/user linkage: {e}")

    # Summary
    print("=" * 60)
    print("RE-SYNC COMPLETE")
    print("=" * 60)
    print(f"  Projects:  {stats['projects']} created")
    print(f"  Offices:   {stats['offices']} created")
    print(f"  Positions: {stats['positions']} created ({len(position_map)} total)")
    print(f"  Employees: {stats['employees']} total")
    print(f"  Mapped:    {mapped} via assigned_employee")
    return stats


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

async def main():
    print("=" * 60)
    print("BHSPL ORG STRUCTURE RE-SYNC")
    print("=" * 60)
    print(f"Time:  {datetime.now(timezone.utc).isoformat()}")
    print(f"DB:    {settings.DB_HOST}:{settings.DB_PORT}/{settings.DB_NAME}")
    print(f"API:   {settings.HR_EMPLOYEE_API_URL}\n")

    if not settings.HR_EMPLOYEE_API_URL or not settings.HR_API_KEY:
        print("ERROR: Set HR_EMPLOYEE_API_URL and HR_API_KEY in .env")
        sys.exit(1)

    headers = {"X-Api-Key": settings.HR_API_KEY, "Accept": "application/json"}

    async with httpx.AsyncClient(timeout=settings.HR_API_TIMEOUT,
                                  follow_redirects=True) as client:
        await drop_and_recreate_tables()
        employee_rows, position_rows = await fetch_all(client, headers)

        if not employee_rows:
            print("ERROR: No employees fetched. Aborting.")
            sys.exit(1)

        async with AsyncSessionLocal() as db:
            await sync_all(db, employee_rows, position_rows, org_id=1)

    print("\nDone!")


if __name__ == "__main__":
    asyncio.run(main())
