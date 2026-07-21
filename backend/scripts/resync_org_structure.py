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
    elif "COO" in words or ("CHIEF" in words and "OPERATING" in words and "OFFICER" in words):
        new_words.append("COO")
    elif "CO" in words:
        new_words.append("CO")
    
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
        for table in ("position_reporting", "positions", "employees", "offices", "projects"):
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
        # Create position_reporting junction table
        await conn.execute(text("""
            CREATE TABLE IF NOT EXISTS position_reporting (
                position_id BIGINT NOT NULL,
                parent_position_id BIGINT NOT NULL,
                PRIMARY KEY (position_id, parent_position_id),
                CONSTRAINT fk_pos_rep_position FOREIGN KEY (position_id) REFERENCES positions(id) ON DELETE CASCADE,
                CONSTRAINT fk_pos_rep_parent FOREIGN KEY (parent_position_id) REFERENCES positions(id) ON DELETE CASCADE
            )
        """))
        await conn.execute(text("SET FOREIGN_KEY_CHECKS = 1"))
        print("  Recreated all tables with current model schema")


# ---------------------------------------------------------------------------
# Step 2 — Fetch all data from HRMS API
# ---------------------------------------------------------------------------

page_request_log = []
insertion_failures = []


async def _fetch_page(client, url, headers, page, label):
    import time
    start_time = time.time()
    for attempt in range(3):
        t0 = time.time()
        status_code = None
        error_msg = None
        try:
            r = await client.get(url, headers=headers)
            t1 = time.time()
            status_code = r.status_code
            r.raise_for_status()
            payload = r.json()
            items = payload.get("results") or payload.get("items") or []
            duration = t1 - t0
            page_request_log.append({
                "label": label,
                "page": page,
                "url": url,
                "status_code": status_code,
                "retries": attempt,
                "response_time": duration,
                "records": len(items)
            })
            return items
        except Exception as e:
            error_msg = str(e)
            duration = time.time() - t0
            if attempt == 2:
                page_request_log.append({
                    "label": label,
                    "page": page,
                    "url": url,
                    "status_code": status_code or "ERROR",
                    "retries": attempt,
                    "response_time": duration,
                    "records": 0,
                    "error": error_msg
                })
                print(f"  Error fetching {label} page {page} (attempt {attempt+1}): {e}")
                raise RuntimeError(f"Failed to fetch {label} page {page} after {attempt+1} attempts: {e}")
            await asyncio.sleep(0.5 * (attempt + 1))


async def _fetch_all_paginated(client, headers, base_url, label):
    import time
    import math
    print(f"  Fetching page 1 for {label}...")
    url = f"{base_url}?page_size=200&page=1"
    t0 = time.time()
    status_code = None
    try:
        r = await client.get(url, headers=headers)
        t1 = time.time()
        status_code = r.status_code
        r.raise_for_status()
        payload = r.json()
    except Exception as e:
        duration = time.time() - t0
        page_request_log.append({
            "label": label,
            "page": 1,
            "url": url,
            "status_code": status_code or "ERROR",
            "retries": 0,
            "response_time": duration,
            "records": 0,
            "error": str(e)
        })
        print(f"  Error fetching {label} page 1: {e}")
        raise RuntimeError(f"Failed to fetch {label} page 1: {e}")

    first_page_items = payload.get("results") or payload.get("items") or []
    duration = t1 - t0
    page_request_log.append({
        "label": label,
        "page": 1,
        "url": url,
        "status_code": status_code,
        "retries": 0,
        "response_time": duration,
        "records": len(first_page_items)
    })
    
    count = payload.get("count") or len(first_page_items)
    
    # Django REST Framework default page size (usually 10 or 20)
    page_size = len(first_page_items) if first_page_items else 10
    if page_size == 0:
        return [], 0
        
    total_pages = math.ceil(count / page_size)
    print(f"  {label.capitalize()} total count: {count}, page size: {page_size}, total pages: {total_pages}")
    
    all_rows = list(first_page_items)
    if total_pages <= 1:
        return all_rows, count

    # Fetch other pages concurrently in batches of 5 to avoid overloading the server
    batch_size = 5
    tasks = []
    for page in range(2, total_pages + 1):
        url = f"{base_url}?page_size=200&page={page}"
        tasks.append((page, url))

    for i in range(0, len(tasks), batch_size):
        if i > 0:
            await asyncio.sleep(0.2)  # Delay between batches to give upstream server breathing room
        batch = tasks[i:i + batch_size]
        print(f"  Fetching {label} pages {batch[0][0]} to {batch[-1][0]} concurrently...")
        futures = [
            _fetch_page(client, url, headers, page, label)
            for page, url in batch
        ]
        results = await asyncio.gather(*futures)
        for items in results:
            all_rows.extend(items)

    return all_rows, count


async def fetch_all(client, headers):
    import os
    if os.environ.get("HR_SYNC_OFFLINE", "false").lower() == "true":
        import json
        print("[2/5] (OFFLINE MOCK) Reading employees from employees_page1.json...")
        with open("employees_page1.json", "r", encoding="utf-8") as f:
            emp_data = json.load(f)
        employee_rows = emp_data.get("results") or []
        emp_count = len(employee_rows)
        print(f"  Total: {len(employee_rows)} employees\n")

        print("[3/5] (OFFLINE MOCK) Reading positions from positions_page1.json...")
        with open("positions_page1.json", "r", encoding="utf-8") as f:
            pos_data = json.load(f)
        position_rows = pos_data.get("results") or []
        pos_count = len(position_rows)
        print(f"  Total: {len(position_rows)} positions\n")
        return employee_rows, emp_count, position_rows, pos_count
    else:
        print("[2/5] Fetching employees from HRMS API...")
        employee_rows, emp_count = await _fetch_all_paginated(client, headers,
                                                             settings.HR_EMPLOYEE_API_URL,
                                                             "employees")
        print(f"  Total: {len(employee_rows)} employees\n")

        print("[3/5] Fetching positions from HRMS API...")
        try:
            position_rows, pos_count = await _fetch_all_paginated(client, headers,
                                                                 _pos_base_url(), "positions")
            print(f"  Total: {len(position_rows)} positions\n")
        except Exception as e:
            print(f"\n  WARNING: Failed to fetch positions from positions API: {e}")
            print("  Gracefully falling back to extracting positions exclusively from employee records.\n")
            position_rows, pos_count = [], 0
        return employee_rows, emp_count, position_rows, pos_count


# ---------------------------------------------------------------------------
# Step 4 — Sync data into the freshly created tables
# ---------------------------------------------------------------------------

async def sync_all(db, employee_rows, position_rows, org_id, emp_expected=0, pos_expected=0):
    # Normalize employee_rows if they are in the flat live API format
    normalized_employee_rows = []
    for row in employee_rows:
        if "employee" not in row:
            # Extract office details
            loc = row.get("location_details") or {}
            if isinstance(loc, list):
                loc = loc[0] if loc else {}
            pos_list = row.get("positions_details") or []
            p = pos_list[0] if pos_list else {}
            
            # Generate a code if not present
            pos_code = p.get("code") or p.get("position_code")
            if not pos_code and p.get("name"):
                pos_code = normalize_position_key(p.get("name"))
            if not pos_code:
                pos_code = f"POS-{p.get('id') or 'UNKNOWN'}"
                
            office_data = {
                "id": loc.get("office_id") or p.get("office_id"),
                "name": loc.get("office_name") or p.get("office_name") or f"Office-{loc.get('office_id') or p.get('office_id') or 'UNKNOWN'}",
                "level": loc.get("office_level_name") or loc.get("level") or "FACILITATE",
                "geo_location": {
                    "country": loc.get("country") or "India",
                    "state": loc.get("state") or "ANDHRA PRADESH",
                    "district": loc.get("district"),
                    "mandal": loc.get("mandal"),
                    "cluster": loc.get("cluster"),
                    "cluster_type": loc.get("cluster_type"),
                    "specific_location": loc.get("specific_location"),
                    "address": loc.get("address")
                }
            }
            
            # Extract parent reporting details
            rep = row.get("reporting_to_details") or {}
            reporting_to_list = []
            if rep:
                if isinstance(rep, list):
                    for item in rep:
                        if isinstance(item, dict):
                            reporting_to_list.append({
                                "id": item.get("position_id"),
                                "position_name": item.get("position_name"),
                                "code": item.get("position_code"),
                                "employee_id": item.get("id"),
                                "employee_name": item.get("name")
                            })
                elif isinstance(rep, dict):
                    reporting_to_list.append({
                        "id": rep.get("position_id"),
                        "position_name": rep.get("position_name"),
                        "code": rep.get("position_code"),
                        "employee_id": rep.get("id"),
                        "employee_name": rep.get("name")
                    })
            
            pos_data = {
                "id": p.get("id"),
                "name": p.get("name") or "Unknown Position",
                "code": pos_code,
                "role_name": p.get("role_name"),
                "role_code": p.get("role_code"),
                "level_name": p.get("level_name") or f"Level-{p.get('level_id') or 5}",
                "level_rank": p.get("level_rank") or p.get("level_id") or 5,
                "department": p.get("department_name"),
                "section": p.get("section_name") or p.get("section"),
                "job_name": p.get("job_name") or p.get("role_name"),
                "job_family_name": p.get("job_family_name"),
                "job_family_id": p.get("job_family_id"),
                "role_type_id": p.get("role_type_id"),
                "status": p.get("status") or "active",
                "start_date": p.get("start_date"),
                "reporting_to": reporting_to_list
            }
            
            proj_name = row.get("project_name") or p.get("project_name") or "AP-104-MMUS"
            proj_code = row.get("project_code") or p.get("project_code") or (proj_name.replace(" ", "-") if proj_name else "AP-104-MMUS")
            
            project_data = {
                "id": row.get("project_id") or p.get("project_id") or 4,
                "name": proj_name,
                "code": proj_code
            }
            
            normalized_row = {
                "employee": {
                    "id": row.get("id"),
                    "name": row.get("name"),
                    "employee_code": row.get("employee_code"),
                    "photo": row.get("photo"),
                    "status": row.get("status") or "Active",
                    "dob": row.get("dob"),
                    "gender": row.get("gender"),
                    "pan_number": row.get("pan_number"),
                    "aadhaar_number": row.get("aadhaar_number"),
                    "email": row.get("email"),
                    "phone": row.get("phone")
                },
                "position": pos_data,
                "project": project_data,
                "office": office_data,
                "bank_details": row.get("bank_details"),
                "hire_date": row.get("hire_date")
            }
            normalized_employee_rows.append(normalized_row)
        else:
            normalized_employee_rows.append(row)
            
    employee_rows = normalized_employee_rows

    print("[4/5] Syncing projects, offices, positions, employees...")
    stats = {"projects": 0, "offices": 0, "positions": 0, "employees": 0}
    created_parent_employees = set()

    # ---- PROJECTS ----
    proj_res = await db.execute(text("SELECT id, UPPER(code) FROM projects"))
    project_map = {r[1]: r[0] for r in proj_res.all() if r[1]}

    record_count = 0
    for row in employee_rows:
        proj = row.get("project") or {}
        code = (_text(proj, "code") or "").upper()
        name = _text(proj, "name") or code
        if code and code not in project_map:
            try:
                proj_id = _int(proj.get("id")) or _int(row.get("project_id")) or _int(proj.get("project_id"))
                r = await db.execute(
                    text("""INSERT INTO projects (id, organization_id, name, code, status, created_at, updated_at)
                            VALUES (:id, :org_id, :name, :code, 'active', NOW(), NOW())"""),
                    {"id": proj_id, "org_id": org_id, "name": name, "code": code}
                )
                project_map[code] = proj_id or r.lastrowid
                stats["projects"] += 1
            except Exception as e:
                err_msg = str(e)
                print(f"  WARN: Could not create project {code}: {err_msg}")
                insertion_failures.append({
                    "type": "project",
                    "code": code,
                    "error": err_msg
                })
        
        record_count += 1
        if record_count % 100 == 0:
            await db.commit()
    await db.commit()
    print(f"  Projects: {stats['projects']} created, {len(project_map)} total")

    # ---- OFFICES ----
    office_res = await db.execute(text("SELECT id, LOWER(name) FROM offices"))
    office_map = {r[1].strip(): r[0] for r in office_res.all() if r[1]}

    record_count = 0
    for row in employee_rows:
        off = row.get("office") or {}
        name = _text(off, "name")
        if not name:
            continue
        key = name.lower().strip()
        if key in office_map:
            continue
        
        geo = off.get("geo_location") or {}
        try:
            office_id = _int(off.get("id")) or _int(row.get("office_id")) or _int(off.get("office_id"))
            r = await db.execute(
                text("""INSERT INTO offices (id, name, level, country, state, district, mandal,
                         cluster, cluster_type, specific_location, address,
                         created_at, updated_at)
                        VALUES (:id, :name, :level, :country, :state, :district, :mandal,
                                :cluster, :cluster_type, :specific_location, :address,
                                NOW(), NOW())"""),
                {"id": office_id, "name": name, "level": _text(off, "level"),
                 "country": _text(geo, "country"), "state": _text(geo, "state"),
                 "district": _text(geo, "district"), "mandal": _text(geo, "mandal"),
                 "cluster": _text(geo, "cluster"), "cluster_type": _text(geo, "cluster_type"),
                 "specific_location": _text(geo, "specific_location"),
                 "address": _text(geo, "address", max_len=2000)}
            )
            office_map[key] = office_id or r.lastrowid
            stats["offices"] += 1
        except Exception as e:
            err_msg = str(e)
            print(f"  WARN: Could not create office {name}: {err_msg}")
            insertion_failures.append({
                "type": "office",
                "code": name,
                "error": err_msg
            })
        
        record_count += 1
        if record_count % 100 == 0:
            await db.commit()
    await db.commit()
    print(f"  Offices: {stats['offices']} created, {len(office_map)} total")

    # ---- POSITIONS (from employee data) ----
    position_map = {}
    parent_relations = []

    # Pre-fetch all roles for in-memory caching
    roles_res = await db.execute(text("SELECT id, LOWER(code), LOWER(name) FROM roles WHERE is_active = 1"))
    roles_db = roles_res.all()
    role_code_to_id = {r[1]: r[0] for r in roles_db if r[1]}
    role_name_to_id = {r[2]: r[0] for r in roles_db if r[2]}

    record_count = 0
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
        reporting_to = pos.get("reporting_to_details") or pos.get("reporting_to") or []
        if isinstance(reporting_to, list):
            for rt in reporting_to:
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
                elif isinstance(rt, (int, float)):
                    parent_relations.append({
                        "child_code": code,
                        "parent_code": None,
                        "parent_name": None,
                        "parent_details": {"id": int(rt)}
                    })

        role_details = pos.get("role_details") or {}
        role_code = _text(pos, "role_code") or role_details.get("code")
        role_name = _text(pos, "role_name") or _text(pos, "role") or role_details.get("name")
        local_role_id = None
        if role_code:
            local_role_id = role_code_to_id.get(role_code.lower())
        if not local_role_id and role_name:
            local_role_id = role_name_to_id.get(role_name.lower())

        try:
            pos_id = _int(pos.get("id")) or _int(row.get("position_id")) or _int(pos.get("position_id"))
            r = await db.execute(
                text("""INSERT INTO positions
                    (id, name, code, role_name, role_id, level_name, level_rank,
                     department, section, job_name, job_family_name, job_family_id,
                     role_type_id, status, start_date, project_id, office_id,
                     created_at, updated_at)
                    VALUES (:id, :name, :code, :role_name, :role_id, :level_name, :level_rank,
                            :department, :section, :job_name, :job_family_name, :job_family_id,
                            :role_type_id, :status, :start_date, :project_id, :office_id,
                            NOW(), NOW())"""),
                {"id": pos_id, "name": name, "code": code,
                 "role_name": _text(pos, "role_name") or _text(role_details, "name"),
                 "role_id": local_role_id,
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
            position_map[code] = pos_id or r.lastrowid
            stats["positions"] += 1
        except Exception as e:
            err_msg = str(e)
            print(f"  WARN: Could not create position {code}: {err_msg}")
            insertion_failures.append({
                "type": "position",
                "code": code,
                "error": err_msg
            })
        
        record_count += 1
        if record_count % 100 == 0:
            await db.commit()

    # Positions from positions API for missed ones
    # Build project name map for positions API lookup
    proj_name_res = await db.execute(text("SELECT id, LOWER(name) FROM projects"))
    project_name_map = {r[1].strip(): r[0] for r in proj_name_res.all() if r[1]}

    record_count = 0
    for pos_row in position_rows:
        code = (_text(pos_row, "code") or "").upper()
        if not code:
            continue
        
        # Collect parent relationship to resolve later
        reporting_to = pos_row.get("reporting_to_details") or pos_row.get("reporting_to") or []
        if isinstance(reporting_to, list):
            for rt in reporting_to:
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
                elif isinstance(rt, (int, float)):
                    parent_relations.append({
                        "child_code": code,
                        "parent_code": None,
                        "parent_name": None,
                        "parent_details": {"id": int(rt)}
                    })

        if code in position_map:
            continue
            
        name = _text(pos_row, "name") or code
        role_details = pos_row.get("role_details") or {}
        role_code = _text(pos_row, "role_code") or role_details.get("code")
        role_name = _text(pos_row, "role_name") or _text(pos_row, "role") or role_details.get("name")
        local_role_id = None
        if role_code:
            local_role_id = role_code_to_id.get(role_code.lower())
        if not local_role_id and role_name:
            local_role_id = role_name_to_id.get(role_name.lower())

        project_name_str = (_text(pos_row, "project_name") or "").lower().strip()
        project_id = project_name_map.get(project_name_str)
        
        office_name_str = (_text(pos_row, "office_name") or "").lower().strip()
        office_id = office_map.get(office_name_str)

        try:
            pos_id = _int(pos_row.get("id")) or _int(pos_row.get("position_id"))
            r = await db.execute(
                text("""INSERT INTO positions
                    (id, name, code, role_name, role_id, level_name, level_rank,
                     department, section, job_name, job_family_name, job_family_id,
                     role_type_id, status, start_date, project_id, office_id, created_at, updated_at)
                    VALUES (:id, :name, :code, :role_name, :role_id, :level_name, :level_rank,
                            :department, :section, :job_name, :job_family_name, :job_family_id,
                            :role_type_id, :status, :start_date, :project_id, :office_id, NOW(), NOW())"""),
                {"id": pos_id, "name": name, "code": code,
                 "role_name": _text(pos_row, "role_name") or _text(role_details, "name"),
                 "role_id": local_role_id,
                 "level_name": _text(pos_row, "level_name") or _text(pos_row, "level"),
                 "level_rank": _int(pos_row.get("level_rank")),
                 "department": _text(pos_row, "department_name") or _text(pos_row, "department"),
                 "section": _text(pos_row, "section_name") or _text(pos_row, "section"),
                 "job_name": _text(pos_row, "job_name") or _text(role_details, "job_name"),
                 "job_family_name": _text(pos_row, "job_family_name"),
                 "job_family_id": _int(pos_row.get("job_family_id")),
                 "role_type_id": _int(pos_row.get("role_type_id")),
                 "status": _text(pos_row, "status") or "active",
                 "start_date": _date(pos_row.get("start_date")),
                 "project_id": project_id,
                 "office_id": office_id}
            )
            position_map[code] = pos_id or r.lastrowid
            stats["positions"] += 1
        except Exception as e:
            err_msg = str(e)
            print(f"  WARN: Could not insert position {code}: {err_msg}")
            insertion_failures.append({
                "type": "position",
                "code": code,
                "error": err_msg
            })
        
        record_count += 1
        if record_count % 100 == 0:
            await db.commit()

    await db.commit()

    # ---- HIERARCHY RESOLUTION AND LINKING (Pass 2) ----
    print("  Resolving position hierarchy using normalized key matching...")
    normalized_to_id = {}
    normalized_name_to_id = {}
    db_positions = (await db.execute(text("SELECT id, code, name FROM positions"))).all()
    for pid, pcode, pname in db_positions:
        if pcode:
            norm_code = normalize_position_key(pcode)
            if norm_code:
                normalized_to_id[norm_code] = pid
        if pname:
            norm_name = normalize_position_key(pname)
            if norm_name:
                normalized_name_to_id[norm_name] = pid

    record_count = 0
    # Clear all existing position reporting mappings
    try:
        await db.execute(text("DELETE FROM position_reporting"))
    except Exception as e:
        print(f"  WARN: Could not clear position_reporting table: {e}")

    set_primary = set()
    for rel in parent_relations:
        child_code = rel["child_code"]
        parent_code = rel["parent_code"]
        parent_name = rel["parent_name"]
        rt = rel["parent_details"]

        child_id = position_map.get(child_code)
        if not child_id:
            continue

        parent_id = None

        # 1. Try exact ID match if present in API response
        p_id_from_api = rt.get("id") or rt.get("position_id")
        if p_id_from_api:
            p_id_from_api = _int(p_id_from_api)
            if p_id_from_api in [p[0] for p in db_positions]:
                parent_id = p_id_from_api

        # 2. Try exact code match in position_map
        if not parent_id and parent_code:
            parent_id = position_map.get(parent_code)

        # 3. Try normalized match by parent_code
        if not parent_id and parent_code:
            norm_parent_code = normalize_position_key(parent_code)
            parent_id = normalized_to_id.get(norm_parent_code)

        # 4. Try normalized match by parent_name
        if not parent_id and parent_name:
            norm_parent_name = normalize_position_key(parent_name)
            parent_id = normalized_name_to_id.get(norm_parent_name)

        if parent_id and child_id != parent_id:
            try:
                # Set the first parent as the primary parent_position_id
                if child_id not in set_primary:
                    await db.execute(
                        text("UPDATE positions SET parent_position_id = :pid WHERE id = :cid"),
                        {"cid": child_id, "pid": parent_id}
                    )
                    set_primary.add(child_id)
                
                # Insert into junction table
                await db.execute(
                    text("""
                        INSERT IGNORE INTO position_reporting (position_id, parent_position_id)
                        VALUES (:cid, :pid)
                    """),
                    {"cid": child_id, "pid": parent_id}
                )
            except Exception as e:
                err_msg = str(e)
                print(f"  WARN: Failed to link child {child_code} to parent {parent_id}: {err_msg}")
                insertion_failures.append({
                    "type": "linkage",
                    "code": f"{child_code}->{parent_id}",
                    "error": err_msg
                })
        
        record_count += 1
        if record_count % 100 == 0:
            await db.commit()

    await db.commit()
    print(f"  Positions: {stats['positions']} created, {len(position_map)} total")

    # ---- EMPLOYEES (bidirectional mapping) ----
    emp_res = await db.execute(text("SELECT id, employee_code FROM employees"))
    employee_cache = {r[1]: r[0] for r in emp_res.all() if r[1]}

    record_count = 0
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

        existing = employee_cache.get(code)

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
                employee_cache[code] = emp_id

                if position_id and emp_id:
                    await db.execute(
                        text("UPDATE positions SET employee_id = :eid WHERE id = :pid AND employee_id IS NULL"),
                        {"pid": position_id, "eid": emp_id}
                    )
            except Exception as e:
                err_msg = str(e)
                print(f"  WARN: Could not create employee {code}: {err_msg}")
                insertion_failures.append({
                    "type": "employee_insert",
                    "code": code,
                    "error": err_msg
                })
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
                err_msg = str(e)
                print(f"  WARN: Could not update employee {code}: {err_msg}")
                insertion_failures.append({
                    "type": "employee_update",
                    "code": code,
                    "error": err_msg
                })
        
        record_count += 1
        if record_count % 100 == 0:
            await db.commit()

    await db.commit()

    # Deterministically update employees.position_id for all employees based on highest level (lowest level_rank) and code
    try:
        await db.execute(text("""
            UPDATE employees e
            JOIN (
                SELECT p1.employee_id, p1.id as primary_pos_id
                FROM positions p1
                JOIN (
                    SELECT employee_id, MIN(level_rank) as min_rank
                    FROM positions
                    WHERE employee_id IS NOT NULL
                    GROUP BY employee_id
                ) p2 ON p1.employee_id = p2.employee_id AND p1.level_rank = p2.min_rank
                WHERE p1.id = (
                    SELECT p3.id FROM positions p3 
                    WHERE p3.employee_id = p1.employee_id AND p3.level_rank = p1.level_rank 
                    ORDER BY p3.code ASC LIMIT 1
                )
            ) t ON e.id = t.employee_id
            SET e.position_id = t.primary_pos_id
        """))
        await db.commit()
    except Exception as e:
        print(f"  WARN: Could not deterministically populate employees.position_id: {e}")

    # Step 5 — Assigned employee from positions API
    print("\n[5/5] Applying assigned_employee from positions API...")
    mapped = 0
    record_count = 0
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
        
        record_count += 1
        if record_count % 100 == 0:
            await db.commit()
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
        # Automatic Orphan Repair
        print("Running automatic orphan repairs...")
        await db.execute(text("""
            UPDATE warehouses 
            SET office_id = NULL 
            WHERE office_id IS NOT NULL 
              AND office_id NOT IN (SELECT id FROM offices)
        """))
        await db.execute(text("""
            UPDATE users 
            SET employee_id = NULL 
            WHERE employee_id IS NOT NULL 
              AND employee_id NOT IN (SELECT id FROM employees)
        """))
        await db.execute(text("""
            UPDATE approval_workflows 
            SET project_id = NULL 
            WHERE project_id IS NOT NULL 
              AND project_id NOT IN (SELECT id FROM projects)
        """))
        await db.commit()
    except Exception as e:
        print(f"  WARN: Error during post-sync warehousing/user linkage: {e}")
        await db.rollback()

    # Run post-sync database integrity validations
    print("Running post-sync database integrity validations...")
    dup_emp = (await db.execute(text("""
        SELECT employee_code, COUNT(*) 
        FROM employees 
        GROUP BY employee_code 
        HAVING COUNT(*) > 1
    """))).all()
    if dup_emp:
        raise ValueError(f"Integrity Violation: Found duplicate employee codes: {dup_emp}")
        
    dup_pos = (await db.execute(text("""
        SELECT code, COUNT(*) 
        FROM positions 
        GROUP BY code 
        HAVING COUNT(*) > 1
    """))).all()
    if dup_pos:
        raise ValueError(f"Integrity Violation: Found duplicate position codes: {dup_pos}")

    dup_off = (await db.execute(text("""
        SELECT name, COUNT(*) 
        FROM offices 
        GROUP BY name 
        HAVING COUNT(*) > 1
    """))).all()
    if dup_off:
        raise ValueError(f"Integrity Violation: Found duplicate office names: {dup_off}")

    dup_proj = (await db.execute(text("""
        SELECT code, COUNT(*) 
        FROM projects 
        GROUP BY code 
        HAVING COUNT(*) > 1
    """))).all()
    if dup_proj:
        raise ValueError(f"Integrity Violation: Found duplicate project codes: {dup_proj}")
        
    dup_pos_combos = (await db.execute(text("""
        SELECT employee_id, role_id, office_id, COUNT(*) 
        FROM positions 
        WHERE employee_id IS NOT NULL AND role_id IS NOT NULL AND office_id IS NOT NULL
        GROUP BY employee_id, role_id, office_id 
        HAVING COUNT(*) > 1
    """))).all()
    if dup_pos_combos:
        raise ValueError(f"Integrity Violation: Found duplicate employee-role-office position assignments: {dup_pos_combos}")
        
    orphans = (await db.execute(text("""
        SELECT p.id, p.code, p.parent_position_id 
        FROM positions p 
        LEFT JOIN positions parent ON p.parent_position_id = parent.id 
        WHERE p.parent_position_id IS NOT NULL AND parent.id IS NULL
    """))).all()
    if orphans:
        raise ValueError(f"Integrity Violation: Found orphan parent_position_ids: {orphans}")

    orphan_wh = (await db.execute(text("""
        SELECT id FROM warehouses 
        WHERE office_id IS NOT NULL AND office_id NOT IN (SELECT id FROM offices)
    """))).all()
    if orphan_wh:
        raise ValueError(f"Integrity Violation: Found orphan office references in warehouses: {orphan_wh}")

    orphan_usr = (await db.execute(text("""
        SELECT id FROM users 
        WHERE employee_id IS NOT NULL AND employee_id NOT IN (SELECT id FROM employees)
    """))).all()
    if orphan_usr:
        raise ValueError(f"Integrity Violation: Found orphan employee references in users: {orphan_usr}")

    # FK Integrity Validation for Master Entities
    invalid_emp_pos = (await db.execute(text("""
        SELECT id FROM employees 
        WHERE position_id IS NOT NULL AND position_id NOT IN (SELECT id FROM positions)
    """))).all()
    if invalid_emp_pos:
        raise ValueError(f"Integrity Violation: Employees referencing non-existent positions: {invalid_emp_pos}")

    invalid_pos_off = (await db.execute(text("""
        SELECT id FROM positions 
        WHERE office_id IS NOT NULL AND office_id NOT IN (SELECT id FROM offices)
    """))).all()
    if invalid_pos_off:
        raise ValueError(f"Integrity Violation: Positions referencing non-existent offices: {invalid_pos_off}")

    invalid_pos_proj = (await db.execute(text("""
        SELECT id FROM positions 
        WHERE project_id IS NOT NULL AND project_id NOT IN (SELECT id FROM projects)
    """))).all()
    if invalid_pos_proj:
        raise ValueError(f"Integrity Violation: Positions referencing non-existent projects: {invalid_pos_proj}")

    # 5. Circular reference detection
    res_hierarchy = (await db.execute(text("SELECT id, parent_position_id FROM positions"))).all()
    pos_parents = {pid: parent_id for pid, parent_id in res_hierarchy}
    for pid in pos_parents:
        visited = set()
        curr = pid
        while curr is not None:
            if curr in visited:
                raise ValueError(f"Integrity Violation: Found circular hierarchy reference at position ID {curr} (visited path: {visited})")
            visited.add(curr)
            curr = pos_parents.get(curr)

    print("Post-sync database integrity validations passed successfully.")

    # Summary and Instrumentation report
    print("=" * 60)
    print("RE-SYNC COMPLETE")
    print("=" * 60)
    print(f"  Projects:  {stats['projects']} created")
    print(f"  Offices:   {stats['offices']} created")
    print(f"  Positions: {stats['positions']} created ({len(position_map)} total)")
    print(f"  Employees: {stats['employees']} total")
    print(f"  Mapped:    {mapped} via assigned_employee")
    
    print("\n" + "=" * 60)
    print("INSTRUMENTATION SUMMARY REPORT")
    print("=" * 60)
    print(f"Total API Employee Records Reported: {emp_expected}")
    print(f"Total API Position Records Reported: {pos_expected}")
    print(f"Successfully Fetched Employee Records: {len(employee_rows)}")
    print(f"Successfully Fetched Position Records: {len(position_rows)}")
    print(f"Successfully Inserted/Updated Employees: {stats['employees']}")
    print(f"Successfully Inserted/Updated Positions: {len(position_map)}")
    
    print("\n--- PAGE REQUESTS LOG ---")
    for req in page_request_log:
        err_info = f" | Error: {req['error']}" if "error" in req else ""
        print(f"[{req['label'].upper()}] Page {req['page']} | URL: {req['url']} | Status: {req['status_code']} | Retries: {req['retries']} | Time: {req['response_time']:.3f}s | Records: {req['records']}{err_info}")
        
    print("\n--- INSERTION FAILURES LOG ---")
    if insertion_failures:
        for fail in insertion_failures:
            print(f"[{fail['type'].upper()}] Code/Identifier: {fail['code']} | Error: {fail['error']}")
    else:
        print("No insertion failures occurred.")
    print("=" * 60)

    # Enforce proactive verification count mismatch check
    # Note: If there are expected records reported, verify that we actually fetched them all
    if emp_expected and len(employee_rows) < emp_expected:
        raise ValueError(f"Proactive Verification Mismatch: Fetched {len(employee_rows)} employees, but API reported {emp_expected}. Aborting resync.")
    if pos_expected and len(position_rows) < pos_expected:
        raise ValueError(f"Proactive Verification Mismatch: Fetched {len(position_rows)} positions, but API reported {pos_expected}. Aborting resync.")

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
        employee_rows, emp_count, position_rows, pos_count = await fetch_all(client, headers)

        if not employee_rows:
            print("ERROR: No employees fetched. Aborting.")
            sys.exit(1)

        async with AsyncSessionLocal() as db:
            org_res = await db.execute(text("SELECT id FROM organizations LIMIT 1"))
            org_id = org_res.scalar() or 1
            await sync_all(db, employee_rows, position_rows, org_id=org_id, emp_expected=emp_count, pos_expected=pos_count)

    print("\nDone!")


if __name__ == "__main__":
    asyncio.run(main())
