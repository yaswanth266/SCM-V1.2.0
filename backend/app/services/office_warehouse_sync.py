import re
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession
from app.models.settings_master import Office, Position
from app.models.warehouse import Warehouse

def sanitize_office_code(name: str, office_id: int) -> str:
    """Sanitize office name to fit a unique 50 character warehouse code."""
    clean = re.sub(r'[^a-zA-Z0-9]', '_', name)
    clean = re.sub(r'_+', '_', clean).strip('_').upper()
    
    base_code = f"OFF_{clean}"
    if len(base_code) <= 50:
        return base_code
    
    suffix = f"_{office_id}"
    max_clean_len = 50 - len("OFF_") - len(suffix)
    return f"OFF_{clean[:max_clean_len]}{suffix}"

async def build_inferred_parent_office_map(db: AsyncSession) -> dict[int, int]:
    """
    Builds a map of office_id -> parent_office_id by inspecting positions' parent_position_id.
    """
    # Fetch positions with office_id and parent_position_id
    q = select(Position).where(Position.office_id.isnot(None), Position.parent_position_id.isnot(None))
    res = await db.execute(q)
    positions = res.scalars().all()
    
    # Store position_id -> office_id lookup
    all_pos_res = await db.execute(select(Position.id, Position.office_id).where(Position.office_id.isnot(None)))
    pos_office_map = {row.id: row.office_id for row in all_pos_res.all()}
    
    inferred_map = {}
    for pos in positions:
        parent_office_id = pos_office_map.get(pos.parent_position_id)
        if parent_office_id and parent_office_id != pos.office_id:
            inferred_map[pos.office_id] = parent_office_id
            
    return inferred_map

async def sync_office_to_warehouse(db: AsyncSession, office: Office, organization_id: int = 1, parent_office_id: int = None) -> Warehouse:
    """Idempotently create or update a SCM warehouse for a given Office."""
    level = (office.level or "").upper()
    if level == "FACILITATE":
        wh_name = f"{office.name} @Storage Area"
        wh_type = "regional"
    else:
        wh_name = f"{office.name} @Storage Location"
        wh_type = "main" if level in ("DISTRICT OFFICE", "REGIONAL OFFICE", "HEAD OFFICE") else "regional"
        
    wh_code = sanitize_office_code(office.name, office.id)
    
    p_off_id = parent_office_id or office.parent_office_id
    parent_wh_id = None
    if p_off_id:
        parent_wh = await db.scalar(select(Warehouse).where(Warehouse.office_id == p_off_id))
        if parent_wh:
            parent_wh_id = parent_wh.id
            
    q = select(Warehouse).where(Warehouse.office_id == office.id)
    wh = (await db.execute(q)).scalar_one_or_none()
    
    if wh:
        wh.name = wh_name
        wh.type = wh_type
        wh.city = office.district or office.cluster
        wh.state = office.state
        wh.address_line1 = office.address or office.specific_location
        wh.parent_id = parent_wh_id
    else:
        attempt = 0
        base_wh_code = wh_code
        while True:
            code_dup = await db.scalar(select(Warehouse).where(Warehouse.code == wh_code))
            if not code_dup:
                break
            attempt += 1
            suffix = f"_{office.id}" if attempt == 1 else f"_{office.id}_{attempt}"
            max_len = 50 - len(suffix)
            wh_code = f"{base_wh_code[:max_len]}{suffix}"
                
        wh = Warehouse(
            organization_id=organization_id,
            code=wh_code,
            name=wh_name,
            type=wh_type,
            city=office.district or office.cluster,
            state=office.state,
            address_line1=office.address or office.specific_location,
            office_id=office.id,
            parent_id=parent_wh_id,
            is_active=True
        )
        db.add(wh)
        
    await db.flush()
    return wh

async def sync_all_offices_to_warehouses(db: AsyncSession, organization_id: int = 1) -> dict:
    """Sync all offices to SCM warehouses, topologically sorted by parent relationship."""
    inferred_parent_map = await build_inferred_parent_office_map(db)
    
    for office_id, parent_id in inferred_parent_map.items():
        await db.execute(
            update(Office)
            .where(Office.id == office_id, Office.parent_office_id.is_(None))
            .values(parent_office_id=parent_id)
        )
    await db.flush()
    
    res = await db.execute(select(Office))
    all_offices = res.scalars().all()
    office_dict = {o.id: o for o in all_offices}
    
    visited = set()
    ordered_offices = []
    
    def visit(off_id):
        if off_id in visited:
            return
        visited.add(off_id)
        off = office_dict.get(off_id)
        if not off:
            return
        p_id = off.parent_office_id or inferred_parent_map.get(off_id)
        if p_id:
            visit(p_id)
        ordered_offices.append(off)
        
    for off in all_offices:
        visit(off.id)
        
    created = 0
    updated = 0
    skipped = 0
    errors = []
    
    for office in ordered_offices:
        try:
            exists = await db.scalar(select(Warehouse.id).where(Warehouse.office_id == office.id))
            p_id = office.parent_office_id or inferred_parent_map.get(office.id)
            await sync_office_to_warehouse(db, office, organization_id, parent_office_id=p_id)
            if exists:
                updated += 1
            else:
                created += 1
        except Exception as e:
            skipped += 1
            errors.append(f"Office {office.name} (ID: {office.id}) error: {str(e)}")
            
    return {
        "created": created,
        "updated": updated,
        "skipped": skipped,
        "errors": errors
    }
