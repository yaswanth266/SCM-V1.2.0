import uuid
from typing import Any, Dict
from fastapi import APIRouter, Depends, Header, HTTPException, status, BackgroundTasks
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from app.database import get_db
from app.config import settings
from app.api.v1.users import (
    _run_sync_background,
    _sync_tasks,
    ensure_organization_structure_schema
)

router = APIRouter()

async def verify_hrms_secret(x_hrms_secret: str = Header(None)):
    expected = settings.HRMS_WEBHOOK_SECRET
    if expected and x_hrms_secret != expected:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or missing X-HRMS-Secret"
        )

@router.post("/hrms", status_code=200)
async def hrms_webhook(
    payload: dict,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    _ = Depends(verify_hrms_secret)
):
    event = payload.get("event")
    data = payload.get("data") or {}
    
    if not event:
        raise HTTPException(status_code=400, detail="Missing event field")
        
    from app.services.office_warehouse_sync import sync_office_to_warehouse
    from app.services.employee_warehouse_sync import sync_position_employee_to_warehouse
    
    if event == "sync.all":
        task_id = str(uuid.uuid4())
        _sync_tasks[task_id] = {"status": "starting", "organization_id": 1}
        background_tasks.add_task(_run_sync_background, task_id, 1000, 1)
        return {"received": True, "event": event, "task_id": task_id, "status": "started"}
        
    await ensure_organization_structure_schema(db)
    processed = []
    
    if event in ("office.created", "office.updated"):
        from app.api.v1.users import _office_id_from_external
        stats = {"offices_created": 0}
        office_id = await _office_id_from_external(db, data, stats)
        if office_id:
            from app.models.settings_master import Office
            office = await db.scalar(select(Office).where(Office.id == office_id))
            if office:
                await sync_office_to_warehouse(db, office)
                processed.append(f"office:{office_id}")
                await db.commit()
                
    elif event in ("position.created", "position.updated"):
        from app.api.v1.users import _position_id_from_external
        stats = {"positions_created": 0, "offices_created": 0, "projects_created": 0}
        pos_id = await _position_id_from_external(db, data, stats, organization_id=1)
        if pos_id:
            from app.models.settings_master import Position
            pos = await db.scalar(select(Position).where(Position.id == pos_id))
            if pos:
                await sync_position_employee_to_warehouse(db, pos)
                processed.append(f"position:{pos_id}")
                await db.commit()
                
    elif event in ("employee.created", "employee.updated"):
        from app.api.v1.users import (
            _upsert_external_employee,
            _link_users_to_employees,
            _apply_position_roles_to_linked_users
        )
        stats = {"positions_created": 0, "offices_created": 0, "projects_created": 0}
        ok, created = await _upsert_external_employee(db, data, stats, organization_id=1)
        if ok:
            await _link_users_to_employees(db)
            await _apply_position_roles_to_linked_users(db)
            
            from app.models.settings_master import Employee, Position
            emp_code = data.get("employee_code") or data.get("employee", {}).get("employee_code")
            if emp_code:
                emp = await db.scalar(select(Employee).where(Employee.employee_code == emp_code))
                if emp:
                    pos_res = await db.execute(select(Position).where(Position.employee_id == emp.id))
                    for pos in pos_res.scalars().all():
                        await sync_position_employee_to_warehouse(db, pos)
                        processed.append(f"position:{pos.id}")
                    processed.append(f"employee:{emp.id}")
            await db.commit()
            
    return {"received": True, "event": event, "processed": processed}
