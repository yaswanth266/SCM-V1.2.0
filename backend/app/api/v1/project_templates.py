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
    project_id: Optional[int] = Query(None),
    template_type: Optional[str] = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    from sqlalchemy import func, or_
    from app.utils.helpers import build_paginated_response
    offset = (page - 1) * page_size
    q = (
        select(ProjectIndentTemplate)
        .options(
            selectinload(ProjectIndentTemplate.project),
            selectinload(ProjectIndentTemplate.items),
        )
    )
    if project_id:
        q = q.where(ProjectIndentTemplate.project_id == project_id)
    if template_type:
        q = q.where(ProjectIndentTemplate.template_type == template_type)
    
    if search:
        q = q.join(ProjectIndentTemplate.project).where(
            or_(
                Project.name.ilike(f"%{search}%"),
                Project.code.ilike(f"%{search}%"),
                ProjectIndentTemplate.template_name.ilike(f"%{search}%"),
            )
        )
        
    count_q = select(func.count(ProjectIndentTemplate.id))
    if project_id:
        count_q = count_q.where(ProjectIndentTemplate.project_id == project_id)
    if template_type:
        count_q = count_q.where(ProjectIndentTemplate.template_type == template_type)
    if search:
        count_q = count_q.join(ProjectIndentTemplate.project).where(
            or_(
                Project.name.ilike(f"%{search}%"),
                Project.code.ilike(f"%{search}%"),
                ProjectIndentTemplate.template_name.ilike(f"%{search}%"),
            )
        )
        
    total = (await db.execute(count_q)).scalar() or 0
    res = await db.execute(q.order_by(ProjectIndentTemplate.updated_at.desc()).offset(offset).limit(page_size))
    rows = res.scalars().all()
    
    items = [{
        "id": r.id,
        "project_id": r.project_id,
        "project_name": r.project.name if r.project else None,
        "project_code": r.project.code if r.project else None,
        "template_name": r.template_name or f"Template #{r.id}",
        "template_type": r.template_type or "dp_project",
        "created_at": r.created_at.isoformat() if r.created_at else None,
        "updated_at": r.updated_at.isoformat() if r.updated_at else None,
        "items_count": len(r.items)
    } for r in rows]
    
    return build_paginated_response(items, total, page, page_size)


@router.get("/by-project/{project_id}")
async def get_templates_by_project(
    project_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Fetch all template names and IDs configured for a specific project."""
    q = (
        select(ProjectIndentTemplate)
        .where(ProjectIndentTemplate.project_id == project_id)
        .options(
            selectinload(ProjectIndentTemplate.items).selectinload(ProjectIndentTemplateItem.item),
            selectinload(ProjectIndentTemplate.items).selectinload(ProjectIndentTemplateItem.uom),
        )
        .order_by(ProjectIndentTemplate.template_name.asc())
    )
    res = await db.execute(q)
    templates = res.scalars().all()

    out = []
    for t in templates:
        items_data = []
        for item_link in t.items:
            items_data.append({
                "id": item_link.id,
                "template_id": item_link.template_id,
                "item_id": item_link.item_id,
                "quantity": item_link.quantity,
                "uom_id": item_link.uom_id,
                "item_name": item_link.item.name if item_link.item else None,
                "item_code": item_link.item.item_code if item_link.item else None,
                "item_type": item_link.item.item_type if item_link.item else None,
                "has_batch": bool(getattr(item_link.item, "has_batch", False)) if item_link.item else False,
                "has_serial": bool(getattr(item_link.item, "has_serial", False)) if item_link.item else False,
                "uom_name": item_link.uom.name if item_link.uom else None,
            })
        out.append({
            "id": t.id,
            "project_id": t.project_id,
            "template_name": t.template_name or f"Template #{t.id}",
            "template_type": t.template_type or "dp_project",
            "items_count": len(t.items),
            "items": items_data,
        })
    return out


@router.get("/{id}", response_model=Optional[ProjectIndentTemplateResponse])
async def get_project_indent_template_by_id(
    id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    q = (
        select(ProjectIndentTemplate)
        .where(ProjectIndentTemplate.id == id)
        .options(
            selectinload(ProjectIndentTemplate.project),
            selectinload(ProjectIndentTemplate.items).selectinload(ProjectIndentTemplateItem.item),
            selectinload(ProjectIndentTemplate.items).selectinload(ProjectIndentTemplateItem.uom),
        )
    )
    res = await db.execute(q)
    template = res.scalar_one_or_none()
    if not template:
        raise HTTPException(status_code=404, detail="Template not found")

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
            "item_type": item_link.item.item_type if item_link.item else None,
            "has_batch": bool(getattr(item_link.item, "has_batch", False)) if item_link.item else False,
            "has_serial": bool(getattr(item_link.item, "has_serial", False)) if item_link.item else False,
            "uom_name": item_link.uom.name if item_link.uom else None,
        })

    return {
        "id": template.id,
        "project_id": template.project_id,
        "project_name": template.project.name if template.project else None,
        "template_name": template.template_name or f"Template #{template.id}",
        "template_type": template.template_type or "dp_project",
        "created_at": template.created_at,
        "updated_at": template.updated_at,
        "items": items_data,
    }


@router.post("", response_model=ProjectIndentTemplateResponse)
async def create_or_update_project_indent_template(
    payload: ProjectIndentTemplateCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_permission("inventory-masters", "create", "inventory-masters")),
):
    if not payload.template_name or not payload.template_name.strip():
        raise HTTPException(status_code=400, detail="Template Name is required")

    template_name_clean = payload.template_name.strip()

    # Enforce project exists
    proj_res = await db.execute(select(Project).where(Project.id == payload.project_id))
    project = proj_res.scalar_one_or_none()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    # If payload.id is provided, look up template by id
    template = None
    if payload.id:
        res_by_id = await db.execute(select(ProjectIndentTemplate).where(ProjectIndentTemplate.id == payload.id))
        template = res_by_id.scalar_one_or_none()

    if not template:
        # Check for existing template with same name in same project
        q_existing = (
            select(ProjectIndentTemplate)
            .where(
                ProjectIndentTemplate.project_id == payload.project_id,
                ProjectIndentTemplate.template_name == template_name_clean,
            )
        )
        res_existing = await db.execute(q_existing)
        existing_template = res_existing.scalar_one_or_none()
        if existing_template:
            raise HTTPException(
                status_code=409,
                detail=f"A template named '{template_name_clean}' already exists for this project."
            )
    else:
        # Check if updating name to a name used by ANOTHER template in the same project
        q_name_conflict = (
            select(ProjectIndentTemplate)
            .where(
                ProjectIndentTemplate.project_id == payload.project_id,
                ProjectIndentTemplate.template_name == template_name_clean,
                ProjectIndentTemplate.id != template.id,
            )
        )
        res_name_conflict = await db.execute(q_name_conflict)
        if res_name_conflict.scalar_one_or_none():
            raise HTTPException(
                status_code=409,
                detail=f"A template named '{template_name_clean}' already exists for this project."
            )

    # ─── ITEM UNIQUENESS VALIDATION PER PROJECT ──────────────────────────────
    # Check if any item in payload already exists in ANOTHER template for this project
    new_item_ids = [it.item_id for it in payload.items]
    if new_item_ids:
        # Fetch all template items belonging to this project (excluding current template if updating)
        conflict_query = (
            select(ProjectIndentTemplateItem, ProjectIndentTemplate, Item)
            .join(ProjectIndentTemplate, ProjectIndentTemplateItem.template_id == ProjectIndentTemplate.id)
            .join(Item, ProjectIndentTemplateItem.item_id == Item.id)
            .where(
                ProjectIndentTemplate.project_id == payload.project_id,
                ProjectIndentTemplateItem.item_id.in_(new_item_ids)
            )
        )
        if template:
            conflict_query = conflict_query.where(ProjectIndentTemplate.id != template.id)
        
        conflict_res = await db.execute(conflict_query)
        conflicts = conflict_res.all()

        if conflicts:
            conflicting_row = conflicts[0]
            conf_item = conflicting_row[2]
            conf_template = conflicting_row[1]
            raise HTTPException(
                status_code=400,
                detail=f"Item '{conf_item.item_code} - {conf_item.name}' is already assigned to template '{conf_template.template_name}' for this project. Items cannot be duplicated across templates of the same project."
            )

    if not template:
        template = ProjectIndentTemplate(
            project_id=payload.project_id,
            template_name=template_name_clean,
            template_type=payload.template_type or "dp_project",
        )
        db.add(template)
        await db.flush()
    else:
        template.template_name = template_name_clean
        if payload.template_type:
            template.template_type = payload.template_type
        # Clear existing items
        await db.execute(
            delete(ProjectIndentTemplateItem).where(ProjectIndentTemplateItem.template_id == template.id)
        )
        await db.flush()

    # Add new items
    for it in payload.items:
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
            "item_type": item_link.item.item_type if item_link.item else None,
            "has_batch": bool(getattr(item_link.item, "has_batch", False)) if item_link.item else False,
            "has_serial": bool(getattr(item_link.item, "has_serial", False)) if item_link.item else False,
            "uom_name": item_link.uom.name if item_link.uom else None,
        })

    return {
        "id": template.id,
        "project_id": template.project_id,
        "project_name": template.project.name if template.project else None,
        "template_name": template.template_name or f"Template #{template.id}",
        "template_type": template.template_type or "dp_project",
        "created_at": template.created_at,
        "updated_at": template.updated_at,
        "items": items_data,
    }


@router.delete("/{id}")
async def delete_project_indent_template(
    id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_permission("inventory-masters", "delete", "inventory-masters")),
):
    q = select(ProjectIndentTemplate).where(ProjectIndentTemplate.id == id)
    res = await db.execute(q)
    template = res.scalar_one_or_none()
    if not template:
        raise HTTPException(status_code=404, detail="Template not found")

    await db.delete(template)
    await db.commit()
    return {"message": "Template deleted successfully"}
