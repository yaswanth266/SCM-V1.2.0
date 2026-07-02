from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from app.models.user import User, UserWarehouse
from app.models.warehouse import Warehouse
from app.models.settings_master import Position, Employee

async def sync_position_employee_to_warehouse(db: AsyncSession, position: Position) -> bool:
    """
    Idempotently map user(s) of this position's employee to the office's warehouse.
    """
    if not position.office_id:
        return False
        
    # Get warehouse linked to this office
    wh_id = await db.scalar(select(Warehouse.id).where(Warehouse.office_id == position.office_id))
    if not wh_id:
        return False
        
    emp_ids = set()
    if position.employee_id:
        emp_ids.add(position.employee_id)
        
    res_emps = await db.execute(select(Employee.id).where(Employee.position_id == position.id))
    for emp_id in res_emps.scalars().all():
        emp_ids.add(emp_id)
        
    if not emp_ids:
        return False
        
    # Find users linked to these employees
    res_users = await db.execute(select(User.id).where(User.employee_id.in_(list(emp_ids))))
    user_ids = res_users.scalars().all()
    if not user_ids:
        return False
        
    mapped_any = False
    for user_id in user_ids:
        exists = await db.scalar(
            select(UserWarehouse.id)
            .where(UserWarehouse.user_id == user_id, UserWarehouse.warehouse_id == wh_id)
        )
        if not exists:
            uw = UserWarehouse(user_id=user_id, warehouse_id=wh_id)
            db.add(uw)
            mapped_any = True
            
    if mapped_any:
        await db.flush()
        
    return mapped_any

async def sync_all_position_employees(db: AsyncSession) -> dict:
    """Bulk backfill all employee-to-warehouse mappings based on positions."""
    q = select(Position).where(Position.office_id.isnot(None))
    res = await db.execute(q)
    positions = res.scalars().all()
    
    mapped = 0
    skipped = 0
    errors = []
    
    for pos in positions:
        try:
            was_mapped = await sync_position_employee_to_warehouse(db, pos)
            if was_mapped:
                mapped += 1
            else:
                skipped += 1
        except Exception as e:
            skipped += 1
            errors.append(f"Position {pos.name} (ID: {pos.id}) error: {str(e)}")
            
    return {
        "mapped": mapped,
        "skipped": skipped,
        "errors": errors
    }
