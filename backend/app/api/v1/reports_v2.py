"""Wave 10 — Reports v2 API (configurable / pivot).

  GET    /reports-v2/schema                  — what's queryable
  POST   /reports-v2/preview                 — run a definition without saving
  GET    /reports-v2/definitions             — list saved
  GET    /reports-v2/definitions/{id}        — fetch + run
  POST   /reports-v2/definitions             — save new
  PUT    /reports-v2/definitions/{id}        — update
  DELETE /reports-v2/definitions/{id}        — delete
  POST   /reports-v2/definitions/{id}/run    — run saved
"""
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select, func, or_
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models.user import User
from app.models.reports import ReportDefinition
from app.services.report_engine import get_schema_meta, run_report
from app.utils.dependencies import get_current_user, require_any_role


router = APIRouter()


@router.get("/schema")
async def get_schema(
    # BUG-FIN-110: gate to roles allowed to author/run cross-domain reports.
    current_user: User = Depends(require_any_role(
        "super_admin", "admin", "accounts_manager", "accounts_officer",
        "purchase_manager", "purchase_officer",
        "warehouse_manager", "project_manager",
    )),
):
    """Discover what dimensions / measures / filterable fields exist per fact table."""
    return get_schema_meta()


@router.post("/preview")
async def preview_report(
    payload: dict,
    limit: int = Query(1000, ge=1, le=10000),
    db: AsyncSession = Depends(get_db),
    # BUG-FIN-109: gate report preview to roles allowed to see cross-domain data.
    current_user: User = Depends(require_any_role(
        "super_admin", "admin", "accounts_manager", "accounts_officer",
        "purchase_manager", "purchase_officer",
        "warehouse_manager", "project_manager",
    )),
):
    """Run a report definition without saving. Body: {source_table, dimensions, measures, filters}."""
    org_id = current_user.organization_id
    return await run_report(db, definition=payload, limit=limit, organization_id=org_id)


@router.get("/definitions")
async def list_definitions(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """List saved reports the current user can see (own + shared in same org)."""
    # BUG-FIN-115: shared reports must NOT leak across organizations.
    # We constrain `is_shared=True` matches to those whose creator is in the
    # caller's organization (look up creator org via the User table).
    same_org_creator_ids = (await db.execute(
        select(User.id).where(User.organization_id == current_user.organization_id)
    )).scalars().all() or [-1]
    shared_in_org_clause = (
        (ReportDefinition.is_shared == True)  # noqa: E712
        & (ReportDefinition.created_by.in_(same_org_creator_ids))
    )
    q = select(ReportDefinition).where(
        or_(
            ReportDefinition.created_by == current_user.id,
            shared_in_org_clause,
        )
    ).order_by(ReportDefinition.id.desc())
    rows = (await db.execute(q)).scalars().all()
    return [
        {
            "id": r.id,
            "name": r.name,
            "description": r.description,
            "source_table": r.source_table,
            "report_type": r.report_type,
            "dimensions": r.dimensions,
            "measures": r.measures,
            "filters": r.filters,
            "chart_type": r.chart_type,
            "is_shared": r.is_shared,
            "created_by": r.created_by,
            "is_mine": r.created_by == current_user.id,
            "created_at": r.created_at.isoformat() if r.created_at else None,
        }
        for r in rows
    ]


@router.get("/definitions/{def_id}")
async def get_definition(
    def_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    r = (await db.execute(select(ReportDefinition).where(ReportDefinition.id == def_id))).scalar_one_or_none()
    if not r:
        raise HTTPException(status_code=404, detail="Report not found")
    if not r.is_shared and r.created_by != current_user.id:
        raise HTTPException(status_code=403, detail="Not allowed to view this report")
    # BUG-FIN-115: even shared reports must be in the caller's org.
    if r.is_shared and r.created_by != current_user.id:
        creator_org = (await db.execute(
            select(User.organization_id).where(User.id == r.created_by)
        )).scalar_one_or_none()
        if creator_org != current_user.organization_id:
            raise HTTPException(status_code=403, detail="Not allowed to view this report")
    return {
        "id": r.id, "name": r.name, "description": r.description,
        "source_table": r.source_table, "report_type": r.report_type,
        "dimensions": r.dimensions, "measures": r.measures, "filters": r.filters,
        "chart_type": r.chart_type, "is_shared": r.is_shared,
        "created_by": r.created_by, "is_mine": r.created_by == current_user.id,
    }


@router.post("/definitions", status_code=201)
async def create_definition(
    payload: dict,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    if not payload.get("name") or not payload.get("source_table"):
        raise HTTPException(status_code=400, detail="name and source_table are required")
    r = ReportDefinition(
        name=payload["name"],
        description=payload.get("description"),
        source_table=payload["source_table"],
        report_type=payload.get("report_type", "pivot"),
        dimensions=payload.get("dimensions") or [],
        measures=payload.get("measures") or [],
        filters=payload.get("filters") or [],
        chart_type=payload.get("chart_type"),
        is_shared=payload.get("is_shared", False),
        created_by=current_user.id,
    )
    db.add(r)
    await db.flush()
    return {"id": r.id, "message": "Report saved"}


@router.put("/definitions/{def_id}")
async def update_definition(
    def_id: int,
    payload: dict,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    r = (await db.execute(select(ReportDefinition).where(ReportDefinition.id == def_id))).scalar_one_or_none()
    if not r:
        raise HTTPException(status_code=404, detail="Report not found")
    if r.created_by != current_user.id:
        raise HTTPException(status_code=403, detail="Only owner can edit")
    for k in ("name", "description", "source_table", "report_type", "dimensions",
              "measures", "filters", "chart_type", "is_shared"):
        if k in payload:
            setattr(r, k, payload[k])
    await db.flush()
    return {"success": True}


@router.delete("/definitions/{def_id}")
async def delete_definition(
    def_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    r = (await db.execute(select(ReportDefinition).where(ReportDefinition.id == def_id))).scalar_one_or_none()
    if not r:
        raise HTTPException(status_code=404, detail="Report not found")
    if r.created_by != current_user.id:
        raise HTTPException(status_code=403, detail="Only owner can delete")
    await db.delete(r)
    await db.flush()
    return {"success": True}


@router.post("/definitions/{def_id}/run")
async def run_definition(
    def_id: int,
    overrides: dict | None = None,
    limit: int = Query(1000, ge=1, le=10000),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Run a saved report. `overrides` may merge extra filters or override the limit."""
    r = (await db.execute(select(ReportDefinition).where(ReportDefinition.id == def_id))).scalar_one_or_none()
    if not r:
        raise HTTPException(status_code=404, detail="Report not found")
    if not r.is_shared and r.created_by != current_user.id:
        raise HTTPException(status_code=403, detail="Not allowed to run this report")
    # BUG-FIN-115: shared report cross-org gate.
    if r.is_shared and r.created_by != current_user.id:
        creator_org = (await db.execute(
            select(User.organization_id).where(User.id == r.created_by)
        )).scalar_one_or_none()
        if creator_org != current_user.organization_id:
            raise HTTPException(status_code=403, detail="Not allowed to run this report")

    definition = {
        "source_table": r.source_table,
        "dimensions": r.dimensions or [],
        "measures": r.measures or [],
        "filters": list(r.filters or []),
    }
    # Merge any extra filters from `overrides`
    if overrides and isinstance(overrides.get("filters"), list):
        definition["filters"] = list(definition["filters"]) + list(overrides["filters"])

    # BUG-FIN-108: scope saved-report runs to the caller's organization.
    org_id = current_user.organization_id
    return await run_report(db, definition=definition, limit=limit, organization_id=org_id)
