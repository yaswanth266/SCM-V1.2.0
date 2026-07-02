from fastapi import APIRouter, Depends, HTTPException, status, Query
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, delete
from sqlalchemy.orm import selectinload
from typing import List, Optional

from app.database import get_db
from app.utils.dependencies import get_current_user, require_permission
from app.models.user import User, Project
from app.models.project_templates import ProjectIndentTemplate, ProjectIndentTemplateItem
from app.models.master import Item, UOM
from app.schemas.master import ProjectIndentTemplateCreate, ProjectIndentTemplateResponse

router = APIRouter()


@router.get("/list")
async def list_project_indent_templates(
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=500),
    search: Optional[str] = Query(None),
    template_type: Optional[str] = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    from sqlalchemy import func
    from app.utils.helpers import build_paginated_response
    offset = (page - 1) * page_size
    q = (
        select(ProjectIndentTemplate)
        .options(
            selectinload(ProjectIndentTemplate.project),
            selectinload(ProjectIndentTemplate.items),
        )
    )
    if template_type:
        q = q.where(ProjectIndentTemplate.template_type == template_type)
    
    if search:
        q = q.join(ProjectIndentTemplate.project).where(
            (Project.name.ilike(f"%{search}%")) | (Project.code.ilike(f"%{search}%"))
        )
        
    count_q = select(func.count(ProjectIndentTemplate.id))
    if template_type:
        count_q = count_q.where(ProjectIndentTemplate.template_type == template_type)
    if search:
        count_q = count_q.join(ProjectIndentTemplate.project).where(
            (Project.name.ilike(f"%{search}%")) | (Project.code.ilike(f"%{search}%"))
        )
        
    total = (await db.execute(count_q)).scalar() or 0
    res = await db.execute(q.order_by(ProjectIndentTemplate.updated_at.desc()).offset(offset).limit(page_size))
    rows = res.scalars().all()
    
    items = [{
        "id": r.id,
        "project_id": r.project_id,
        "project_name": r.project.name if r.project else None,
        "project_code": r.project.code if r.project else None,
        "template_type": r.template_type,
        "created_at": r.created_at.isoformat() if r.created_at else None,
        "updated_at": r.updated_at.isoformat() if r.updated_at else None,
        "items_count": len(r.items)
    } for r in rows]
    
    return build_paginated_response(items, total, page, page_size)


@router.get("", response_model=Optional[ProjectIndentTemplateResponse])
async def get_project_indent_template(
    project_id: int,
    template_type: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    # Fetch template
    q = (
        select(ProjectIndentTemplate)
        .where(
            ProjectIndentTemplate.project_id == project_id,
            ProjectIndentTemplate.template_type == template_type,
        )
        .options(
            selectinload(ProjectIndentTemplate.project),
            selectinload(ProjectIndentTemplate.items).selectinload(ProjectIndentTemplateItem.item),
            selectinload(ProjectIndentTemplate.items).selectinload(ProjectIndentTemplateItem.uom),
        )
    )
    res = await db.execute(q)
    template = res.scalar_one_or_none()
    if not template:
        return None

    # Construct response manually to enrich item details
    items_data = []
    for item_link in template.items:
        items_data.append({
            "id": item_link.id,
            "template_id": item_link.template_id,
            "item_id": item_link.item_id,
            "quantity": item_link.quantity,
            "uom_id": item_link.uom_id,
            "item_name": item_link.item.name if item_link.item else None,
            "item_code": item_link.item.item_code if item_link.item else None,
            "uom_name": item_link.uom.name if item_link.uom else None,
        })

    return {
        "id": template.id,
        "project_id": template.project_id,
        "project_name": template.project.name if template.project else None,
        "template_type": template.template_type,
        "created_at": template.created_at,
        "updated_at": template.updated_at,
        "items": items_data,
    }


@router.post("", response_model=ProjectIndentTemplateResponse)
async def upsert_project_indent_template(
    payload: ProjectIndentTemplateCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_permission("inventory-masters", "create", "inventory-masters")),
):
    # Enforce project exists
    proj_res = await db.execute(select(Project).where(Project.id == payload.project_id))
    project = proj_res.scalar_one_or_none()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    # Fetch existing template or create new
    q = (
        select(ProjectIndentTemplate)
        .where(
            ProjectIndentTemplate.project_id == payload.project_id,
            ProjectIndentTemplate.template_type == payload.template_type,
        )
    )
    res = await db.execute(q)
    template = res.scalar_one_or_none()

    if not template:
        template = ProjectIndentTemplate(
            project_id=payload.project_id,
            template_type=payload.template_type,
        )
        db.add(template)
        await db.flush()
    else:
        # Clear existing items
        await db.execute(
            delete(ProjectIndentTemplateItem).where(ProjectIndentTemplateItem.template_id == template.id)
        )
        await db.flush()

    # Add new items
    for it in payload.items:
        # Auto-pick uom_id if not supplied
        uom_id = it.uom_id
        if not uom_id:
            item_q = await db.execute(select(Item).where(Item.id == it.item_id))
            found_item = item_q.scalar_one_or_none()
            if found_item:
                uom_id = found_item.primary_uom_id

        ti = ProjectIndentTemplateItem(
            template_id=template.id,
            item_id=it.item_id,
            quantity=it.quantity,
            uom_id=uom_id,
        )
        db.add(ti)

    await db.commit()

    # Re-fetch template with relations for response
    q_re = (
        select(ProjectIndentTemplate)
        .where(ProjectIndentTemplate.id == template.id)
        .options(
            selectinload(ProjectIndentTemplate.project),
            selectinload(ProjectIndentTemplate.items).selectinload(ProjectIndentTemplateItem.item),
            selectinload(ProjectIndentTemplate.items).selectinload(ProjectIndentTemplateItem.uom),
        )
    )
    res_re = await db.execute(q_re)
    template = res_re.scalar()

    items_data = []
    for item_link in template.items:
        items_data.append({
            "id": item_link.id,
            "template_id": item_link.template_id,
            "item_id": item_link.item_id,
            "quantity": item_link.quantity,
            "uom_id": item_link.uom_id,
            "item_name": item_link.item.name if item_link.item else None,
            "item_code": item_link.item.item_code if item_link.item else None,
            "uom_name": item_link.uom.name if item_link.uom else None,
        })

    return {
        "id": template.id,
        "project_id": template.project_id,
        "project_name": template.project.name if template.project else None,
        "template_type": template.template_type,
        "created_at": template.created_at,
        "updated_at": template.updated_at,
        "items": items_data,
    }
