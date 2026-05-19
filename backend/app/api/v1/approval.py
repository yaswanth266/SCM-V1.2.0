from datetime import datetime, timezone
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, field_validator
from typing import Optional, List
from sqlalchemy import select, func, and_, or_
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload
from app.database import get_db
from app.models.user import User
from app.models.approval import (
    ApprovalWorkflow, ApprovalLevel, ApprovalRequest, ApprovalHistory,
    ApprovalDelegation,
)
from app.services.approval_service import (
    process_approval_action, can_user_approve, get_pending_approvals,
    active_delegations_for, find_sla_breaches, process_escalations,
)
from app.utils.dependencies import get_current_user, require_any_role
from app.utils.helpers import paginate_params, build_paginated_response

router = APIRouter()


class WorkflowLevelInput(BaseModel):
    """BUG-APR-039 — typed shape for one level inside a WorkflowCreate /
    WorkflowUpdate payload. The legacy `List[dict]` accepted any keys at
    all (including misspellings) and silently dropped unknown ones. This
    accepts both `level` and `level_number` aliases for compatibility.
    """
    level: Optional[int] = None
    level_number: Optional[int] = None
    approver_role_id: Optional[int] = None
    approver_role: Optional[int] = None  # alias
    approver_user_id: Optional[int] = None
    approver_user: Optional[int] = None  # alias
    min_amount: Optional[float] = 0
    max_amount: Optional[float] = 999999999
    auto_approve_after_days: Optional[int] = 0
    send_email: Optional[bool] = True
    send_notification: Optional[bool] = True
    escalation_user_id: Optional[int] = None
    escalation_after_hours: Optional[int] = 0
    department: Optional[str] = None
    category: Optional[str] = None
    request_type: Optional[str] = None
    condition_json: Optional[str] = None
    requires_all: Optional[bool] = False

    @field_validator("requires_all")
    @classmethod
    def _val_requires_all(cls, v):
        # BUG-APR-038 — refuse truthy non-bool input. Pydantic's default
        # bool coerces "yes"/1/"on"/"" inconsistently across versions.
        if v is None:
            return False
        if isinstance(v, bool):
            return v
        raise ValueError("requires_all must be a boolean")


class WorkflowCreate(BaseModel):
    name: str
    module: str
    document_type: str
    project_id: Optional[int] = None
    is_active: Optional[bool] = True
    # BUG-APR-039 — typed level shape; old `List[dict]` accepted anything.
    levels: Optional[List[WorkflowLevelInput]] = None


class LevelCreate(BaseModel):
    workflow_id: int
    level: int
    approver_role_id: Optional[int] = None
    approver_user_id: Optional[int] = None
    min_amount: float = 0
    max_amount: float = 999999999
    auto_approve_after_days: int = 0
    send_email: bool = True
    send_notification: bool = True
    # SLA escalation (Wave 2)
    escalation_user_id: Optional[int] = None
    escalation_after_hours: int = 0
    # Conditional routing (Wave 3) — null on any of these = no constraint
    department: Optional[str] = None
    category: Optional[str] = None
    request_type: Optional[str] = None
    condition_json: Optional[str] = None  # raw JSON; engine parses
    # Parallel approvers (Wave 4)
    requires_all: bool = False


class ApprovalItemOverride(BaseModel):
    """Per-line approved_qty override sent with an approval action.

    Currently honoured for document_type='indent' so an L2 approver can
    grant a smaller qty than was requested. Items not listed retain their
    existing approved_qty (which defaults to requested_qty on submit).
    """
    item_id: int  # IndentItem.id (not Item.id)
    approved_qty: float


class ApprovalActionRequest(BaseModel):
    action: str  # approved, rejected, on_hold, returned
    comments: Optional[str] = None
    item_overrides: Optional[List[ApprovalItemOverride]] = None


# ==================== WORKFLOW CONFIG ====================

@router.get("/workflows")
async def list_workflows(
    module: str = Query(None),
    db: AsyncSession = Depends(get_db),
    # BUG-APR-035 — approvers (and the originators they approve for)
    # legitimately need to see *which* workflow drives their inbox so the
    # SLA/escalation badges in the UI can be interpreted. Read access is
    # safe (no secrets, just routing rules); write access stays admin-only
    # via the POST/PUT endpoints below.
    current_user: User = Depends(get_current_user),
):
    query = select(ApprovalWorkflow).options(selectinload(ApprovalWorkflow.levels))
    if module:
        query = query.where(ApprovalWorkflow.module == module)
    result = await db.execute(query.order_by(ApprovalWorkflow.module))
    workflows = result.scalars().all()

    return [{
        "id": w.id, "name": w.name, "module": w.module,
        "document_type": w.document_type, "project_id": w.project_id,
        "is_active": w.is_active,
        "levels": [{
            "id": l.id, "level": l.level,
            "approver_role_id": l.approver_role_id,
            "approver_user_id": l.approver_user_id,
            "min_amount": float(l.min_amount), "max_amount": float(l.max_amount),
            "escalation_user_id": l.escalation_user_id,
            "escalation_after_hours": l.escalation_after_hours,
            "auto_approve_after_days": l.auto_approve_after_days,
            "department": l.department,
            "category": l.category,
            "request_type": l.request_type,
            "condition_json": l.condition_json,
            "requires_all": l.requires_all,
        } for l in w.levels] if w.levels else [],
    } for w in workflows]


@router.post("/workflows", status_code=201)
async def create_workflow(
    payload: WorkflowCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_any_role("admin", "super_admin")),
):
    """Create a workflow. If `levels` is provided, also persists them
    in one shot (so the admin UI doesn't need a follow-up call)."""
    data = payload.model_dump()
    levels_data = data.pop("levels", None)

    # BUG-APR-037 — refuse duplicate or non-contiguous level numbers up
    # front. The engine treats the `level` integer as the routing key, so
    # two L2s or a workflow that jumps {1,3,5} (missing 2 and 4) routes
    # unpredictably and `total_levels` accounting in submit_for_approval
    # gets confused.
    if levels_data:
        seen_levels: list[int] = []
        for lvl in levels_data:
            n = lvl.get("level") or lvl.get("level_number") or 1
            seen_levels.append(int(n))
        if len(set(seen_levels)) != len(seen_levels):
            raise HTTPException(
                status_code=400,
                detail="Duplicate level numbers are not allowed",
            )
        seen_levels.sort()
        # Levels must start at 1 and be contiguous (1, 2, 3, …).
        if seen_levels and (seen_levels[0] != 1 or any(
            seen_levels[i + 1] - seen_levels[i] != 1
            for i in range(len(seen_levels) - 1)
        )):
            raise HTTPException(
                status_code=400,
                detail=(
                    "Workflow levels must start at 1 and be contiguous "
                    "(e.g. 1, 2, 3 — not 1, 3, 5)"
                ),
            )

    wf = ApprovalWorkflow(**data)
    db.add(wf)
    await db.flush()
    if levels_data:
        for lvl in levels_data:
            db.add(ApprovalLevel(
                workflow_id=wf.id,
                level=lvl.get("level") or lvl.get("level_number") or 1,
                approver_role_id=lvl.get("approver_role_id") or lvl.get("approver_role"),
                approver_user_id=lvl.get("approver_user_id") or lvl.get("approver_user"),
                min_amount=lvl.get("min_amount", 0),
                max_amount=lvl.get("max_amount") or 999999999,
                auto_approve_after_days=lvl.get("auto_approve_after_days") or 0,
                send_email=lvl.get("send_email", True),
                send_notification=lvl.get("send_notification", True),
                escalation_user_id=lvl.get("escalation_user_id"),
                escalation_after_hours=lvl.get("escalation_after_hours", 0) or 0,
                department=lvl.get("department") or None,
                category=lvl.get("category") or None,
                request_type=lvl.get("request_type") or None,
                condition_json=lvl.get("condition_json") or None,
                requires_all=bool(lvl.get("requires_all", False)),
            ))
        await db.flush()
    return {"id": wf.id, "message": "Workflow created"}


class WorkflowUpdate(BaseModel):
    """Payload for PUT /approvals/workflows/{id}. All fields optional —
    if `levels` is provided, the existing levels are replaced wholesale."""
    name: Optional[str] = None
    module: Optional[str] = None
    document_type: Optional[str] = None
    project_id: Optional[int] = None
    is_active: Optional[bool] = None
    # BUG-APR-039 — typed input shape (see WorkflowLevelInput above).
    levels: Optional[List[WorkflowLevelInput]] = None


@router.get("/workflows/{workflow_id}")
async def get_workflow(
    workflow_id: int,
    db: AsyncSession = Depends(get_db),
    # BUG-APR-035 — read access opened to any authenticated user; mutations
    # below (PUT/DELETE/level CRUD) remain admin-only.
    current_user: User = Depends(get_current_user),
):
    """BUG-APR-036 / BUG-APR-051 — single-workflow fetch for the admin
    edit drawer. Mirrors the row shape of GET /approvals/workflows."""
    result = await db.execute(
        select(ApprovalWorkflow)
        .options(selectinload(ApprovalWorkflow.levels))
        .where(ApprovalWorkflow.id == workflow_id)
    )
    w = result.scalar_one_or_none()
    if not w:
        raise HTTPException(status_code=404, detail="Workflow not found")
    return {
        "id": w.id, "name": w.name, "module": w.module,
        "document_type": w.document_type, "project_id": w.project_id,
        "is_active": w.is_active,
        "levels": [{
            "id": l.id, "level": l.level,
            "approver_role_id": l.approver_role_id,
            "approver_user_id": l.approver_user_id,
            "min_amount": float(l.min_amount), "max_amount": float(l.max_amount),
            "escalation_user_id": l.escalation_user_id,
            "escalation_after_hours": l.escalation_after_hours,
            "auto_approve_after_days": l.auto_approve_after_days,
            "department": l.department,
            "category": l.category,
            "request_type": l.request_type,
            "condition_json": l.condition_json,
            "requires_all": l.requires_all,
        } for l in (sorted(w.levels, key=lambda x: x.level) if w.levels else [])],
    }


@router.put("/workflows/{workflow_id}")
async def update_workflow(
    workflow_id: int,
    payload: WorkflowUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_any_role("super_admin", "admin")),
):
    """BUG-APR-036 / BUG-APR-052 — replace-style update. Scalar fields are
    patched in-place; if `levels` is provided, existing levels are deleted
    and recreated from the payload (matches the create endpoint's shape).
    Anything not provided is left untouched.
    """
    result = await db.execute(
        select(ApprovalWorkflow).where(ApprovalWorkflow.id == workflow_id)
    )
    wf = result.scalar_one_or_none()
    if not wf:
        raise HTTPException(status_code=404, detail="Workflow not found")

    data = payload.model_dump(exclude_unset=True)
    levels_data = data.pop("levels", None)
    for k, v in data.items():
        setattr(wf, k, v)

    # BUG-APR-037 — same contiguity rule on update.
    if levels_data:
        seen_levels: list[int] = []
        for lvl in levels_data:
            n = lvl.get("level") or lvl.get("level_number") or 1
            seen_levels.append(int(n))
        if len(set(seen_levels)) != len(seen_levels):
            raise HTTPException(
                status_code=400,
                detail="Duplicate level numbers are not allowed",
            )
        seen_levels.sort()
        if seen_levels and (seen_levels[0] != 1 or any(
            seen_levels[i + 1] - seen_levels[i] != 1
            for i in range(len(seen_levels) - 1)
        )):
            raise HTTPException(
                status_code=400,
                detail=(
                    "Workflow levels must start at 1 and be contiguous "
                    "(e.g. 1, 2, 3 — not 1, 3, 5)"
                ),
            )

    if levels_data is not None:
        # Replace all levels in-place. Mirrors the create-time shape so the
        # admin UI can save the same payload it sent to POST /workflows.
        await db.execute(
            ApprovalLevel.__table__.delete().where(
                ApprovalLevel.workflow_id == wf.id
            )
        )
        for lvl in levels_data:
            db.add(ApprovalLevel(
                workflow_id=wf.id,
                level=lvl.get("level") or lvl.get("level_number") or 1,
                approver_role_id=lvl.get("approver_role_id") or lvl.get("approver_role"),
                approver_user_id=lvl.get("approver_user_id") or lvl.get("approver_user"),
                min_amount=lvl.get("min_amount", 0),
                max_amount=lvl.get("max_amount") or 999999999,
                auto_approve_after_days=lvl.get("auto_approve_after_days") or 0,
                send_email=lvl.get("send_email", True),
                send_notification=lvl.get("send_notification", True),
                escalation_user_id=lvl.get("escalation_user_id"),
                escalation_after_hours=lvl.get("escalation_after_hours", 0) or 0,
                department=lvl.get("department") or None,
                category=lvl.get("category") or None,
                request_type=lvl.get("request_type") or None,
                condition_json=lvl.get("condition_json") or None,
                requires_all=bool(lvl.get("requires_all", False)),
            ))

    await db.flush()
    return {"success": True, "id": wf.id, "message": "Workflow updated"}


@router.post("/workflows/levels", status_code=201)
async def add_approval_level(
    payload: LevelCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_any_role("admin", "super_admin")),
):
    # BUG-APR-040 — verify the parent workflow exists. Without this an
    # invalid workflow_id silently fails at FK insert time (or worse, on
    # SQLite/test DBs without enforced FKs, creates a dangling level row
    # that never resolves).
    wf_check = await db.execute(
        select(ApprovalWorkflow.id).where(ApprovalWorkflow.id == payload.workflow_id)
    )
    if wf_check.scalar_one_or_none() is None:
        raise HTTPException(status_code=404, detail="Workflow not found")

    # BUG-APR-040 — also refuse duplicate level numbers within the same
    # workflow, matching the create_workflow contiguity rule.
    dup_check = await db.execute(
        select(ApprovalLevel.id).where(
            ApprovalLevel.workflow_id == payload.workflow_id,
            ApprovalLevel.level == payload.level,
        )
    )
    if dup_check.scalar_one_or_none() is not None:
        raise HTTPException(
            status_code=400,
            detail=f"Level {payload.level} already exists on this workflow",
        )

    level = ApprovalLevel(**payload.model_dump())
    db.add(level)
    await db.flush()
    return {"id": level.id, "message": "Approval level added"}


@router.delete("/workflows/{workflow_id}")
async def deactivate_workflow(
    workflow_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_any_role("admin", "super_admin")),
):
    result = await db.execute(select(ApprovalWorkflow).where(ApprovalWorkflow.id == workflow_id))
    wf = result.scalar_one_or_none()
    if not wf:
        raise HTTPException(status_code=404, detail="Workflow not found")
    wf.is_active = False

    # BUG-APR-054 — deactivating a workflow used to leave pending
    # ApprovalRequests against it stranded forever (they'd never appear in
    # any active queue and the source documents would sit in
    # pending_approval indefinitely). Cancel any open pending requests
    # tied to this workflow and write a history row so audit shows why.
    pending_rows = await db.execute(
        select(ApprovalRequest).where(
            ApprovalRequest.workflow_id == workflow_id,
            ApprovalRequest.status == "pending",
        )
    )
    cancelled_count = 0
    for req in pending_rows.scalars().all():
        req.status = "cancelled"
        req.completed_at = datetime.now(timezone.utc)
        db.add(ApprovalHistory(
            request_id=req.id,
            level=req.current_level,
            action="rejected",
            action_by=current_user.id,
            comments=f"Workflow {workflow_id} deactivated; request cancelled",
        ))
        cancelled_count += 1

    await db.flush()
    return {
        "success": True,
        "message": "Workflow deactivated",
        "cancelled_pending_requests": cancelled_count,
    }


# ==================== APPROVAL REQUESTS ====================

@router.get("/requests")
async def list_approval_requests(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    status: str = Query(None),
    document_type: str = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    offset, limit = paginate_params(page, page_size)
    query = select(ApprovalRequest).options(
        selectinload(ApprovalRequest.history),
        selectinload(ApprovalRequest.requester),
        selectinload(ApprovalRequest.escalated_to),
    )
    count_query = select(func.count(ApprovalRequest.id))

    if status:
        query = query.where(ApprovalRequest.status == status)
        count_query = count_query.where(ApprovalRequest.status == status)
    if document_type:
        query = query.where(ApprovalRequest.document_type == document_type)
        count_query = count_query.where(ApprovalRequest.document_type == document_type)

    # BUG-APR-041 / BUG-APR-042 — IDOR: previously every authenticated user
    # saw every approval request system-wide. Scope down to: super_admin/admin,
    # the requester, the current-level approver (by user or by role), the
    # user a delegation routes to, or the user the request is escalated to.
    from app.utils.dependencies import get_user_role_codes
    from app.models.user import UserRole as _UserRole
    role_codes = await get_user_role_codes(db, current_user.id)
    is_admin = bool({"super_admin", "admin"} & set(role_codes))
    if not is_admin:
        # Roles held by the current user
        urow = await db.execute(
            select(_UserRole.role_id).where(_UserRole.user_id == current_user.id)
        )
        my_role_ids = [r[0] for r in urow.all()]
        # Active delegations into me
        from app.services.approval_service import delegated_user_ids_for
        delegated_from = list(await delegated_user_ids_for(db, current_user.id))
        # Roles those delegators hold (so role-assigned levels also resolve)
        delegated_role_ids: list = []
        if delegated_from:
            drow = await db.execute(
                select(_UserRole.role_id).where(_UserRole.user_id.in_(delegated_from))
            )
            delegated_role_ids = [r[0] for r in drow.all()]
        all_role_ids = list(set(my_role_ids) | set(delegated_role_ids))
        approver_user_ids = [current_user.id] + delegated_from

        # Subquery: ids of requests where current user (or a delegator) is
        # the approver at the request's current_level.
        level_conditions = [ApprovalLevel.approver_user_id.in_(approver_user_ids)]
        if all_role_ids:
            level_conditions.append(ApprovalLevel.approver_role_id.in_(all_role_ids))
        level_subq = (
            select(ApprovalRequest.id)
            .join(
                ApprovalLevel,
                and_(
                    ApprovalLevel.workflow_id == ApprovalRequest.workflow_id,
                    ApprovalLevel.level == ApprovalRequest.current_level,
                ),
            )
            .where(or_(*level_conditions))
        )
        scope = or_(
            ApprovalRequest.requested_by == current_user.id,
            ApprovalRequest.escalated_to_user_id == current_user.id,
            ApprovalRequest.id.in_(level_subq),
        )
        query = query.where(scope)
        count_query = count_query.where(scope)

    total = (await db.execute(count_query)).scalar()
    result = await db.execute(query.offset(offset).limit(limit).order_by(ApprovalRequest.id.desc()))
    requests = result.scalars().all()

    # Resolve all user IDs in requests + history to names
    all_user_ids = set()
    for r in requests:
        if r.requested_by:
            all_user_ids.add(r.requested_by)
        for h in (r.history or []):
            if h.action_by:
                all_user_ids.add(h.action_by)
    user_map = {}
    if all_user_ids:
        user_result = await db.execute(
            select(User.id, User.username, User.first_name, User.last_name)
            .where(User.id.in_(list(all_user_ids)))
        )
        for row in user_result:
            name = f"{row.first_name or ''} {row.last_name or ''}".strip() or row.username
            user_map[row.id] = name

    items = [{
        "id": r.id, "document_type": r.document_type, "document_id": r.document_id,
        "document_number": r.document_number, "current_level": r.current_level,
        "total_levels": r.total_levels, "status": r.status,
        "requested_by": r.requested_by,
        "requested_by_name": user_map.get(r.requested_by, str(r.requested_by) if r.requested_by else "-"),
        "requested_at": r.requested_at,
        "completed_at": r.completed_at,
        "history": [{
            "level": h.level, "action": h.action, "action_by": h.action_by,
            "action_by_name": user_map.get(h.action_by, str(h.action_by) if h.action_by else "-"),
            "action_date": h.action_date, "comments": h.comments,
        } for h in r.history] if r.history else [],
    } for r in requests]

    return build_paginated_response(items, total, page, page_size)


@router.get("/pending/counts")
async def get_pending_counts(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Get count of pending approvals per document type for tab badges."""
    pending = await get_pending_approvals(db, current_user.id)
    counts = {}
    for r in pending:
        dt = r.document_type or "other"
        counts[dt] = counts.get(dt, 0) + 1
    return counts


@router.get("/pending/{request_id}/detail")
async def get_pending_detail(
    request_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Get the source document detail for an approval request.

    Access rule: the caller must be either (a) an approver for this request's
    current level (via `can_user_approve`), (b) super_admin/admin, or (c) the
    user who raised the request. Anyone else gets 403 — we used to return full
    document contents including amounts to any authenticated user.
    """
    result = await db.execute(select(ApprovalRequest).where(ApprovalRequest.id == request_id))
    req = result.scalar_one_or_none()
    if not req:
        raise HTTPException(status_code=404, detail="Approval request not found")

    # Authorization
    from app.utils.dependencies import get_user_role_codes
    role_codes = await get_user_role_codes(db, current_user.id)
    is_admin = bool({"super_admin", "admin"} & set(role_codes))
    is_requester = req.requested_by == current_user.id
    can_approve = False
    if not is_admin and not is_requester:
        can_approve = await can_user_approve(db, request_id, current_user.id)
    if not (is_admin or is_requester or can_approve):
        raise HTTPException(status_code=403, detail="Not authorized to view this approval")

    # Fetch the source document
    detail = {"document_type": req.document_type, "document_number": req.document_number, "remarks": None, "items": []}
    try:
        doc_data = await _fetch_document_detail(db, req.document_type, req.document_id)
        if doc_data:
            detail.update(doc_data)
    except Exception as e:
        import logging
        logging.getLogger(__name__).exception(
            "Failed to fetch document detail for %s/%s: %s",
            req.document_type, req.document_id, e,
        )
    return detail


@router.get("/pending/{request_id}/steps")
async def get_pending_steps(
    request_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Get approval workflow steps/history for a request."""
    result = await db.execute(
        select(ApprovalRequest).options(selectinload(ApprovalRequest.history))
        .where(ApprovalRequest.id == request_id)
    )
    req = result.scalar_one_or_none()
    if not req:
        raise HTTPException(status_code=404, detail="Approval request not found")

    steps = []
    for h in (req.history or []):
        steps.append({
            "level": h.level,
            "action": h.action,
            "action_by": h.action_by,
            "action_date": h.action_date,
            "comments": h.comments,
        })
    return steps


class FrontendActionPayload(BaseModel):
    comments: Optional[str] = None
    action: Optional[str] = None
    item_overrides: Optional[List[ApprovalItemOverride]] = None


@router.post("/pending/{request_id}/approve")
async def approve_pending(
    request_id: int,
    payload: FrontendActionPayload = FrontendActionPayload(),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Approve a pending request (frontend-compatible alias)."""
    action_payload = ApprovalActionRequest(
        action="approved",
        comments=payload.comments,
        item_overrides=payload.item_overrides,
    )
    return await process_action(request_id=request_id, payload=action_payload, db=db, current_user=current_user)


@router.post("/pending/{request_id}/reject")
async def reject_pending(
    request_id: int,
    payload: FrontendActionPayload = FrontendActionPayload(),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Reject a pending request (frontend-compatible alias)."""
    action_payload = ApprovalActionRequest(action="rejected", comments=payload.comments)
    return await process_action(request_id=request_id, payload=action_payload, db=db, current_user=current_user)


@router.post("/pending/{request_id}/hold")
async def hold_pending(
    request_id: int,
    payload: FrontendActionPayload = FrontendActionPayload(),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Put a pending request on hold (frontend-compatible alias)."""
    action_payload = ApprovalActionRequest(action="on_hold", comments=payload.comments)
    return await process_action(request_id=request_id, payload=action_payload, db=db, current_user=current_user)


class BulkActionPayload(BaseModel):
    """Schema for /pending/bulk-action. Replaces `payload: dict` with a strict
    validator so callers can't pass arbitrary keys or non-list ids."""
    ids: List[int]
    action: str  # "approve" | "reject" | "hold"
    comments: Optional[str] = None

    # BUG-APR-021 — was previously a bare @classmethod with no
    # @field_validator decorator, so pydantic never invoked it and bad
    # `action` values made it through to the handler's runtime check.
    @field_validator("action")
    @classmethod
    def _val_action(cls, v: str) -> str:
        if v not in ("approve", "reject", "hold"):
            raise ValueError("action must be approve, reject or hold")
        return v


@router.post("/pending/bulk-action")
async def bulk_action(
    payload: BulkActionPayload,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Bulk approve/reject/hold multiple requests.

    Each id is still routed through `process_action`, which enforces
    `can_user_approve` per-request. The schema caps at a reasonable size so
    this can't be used to trigger thousands of SQL writes in one call.
    """
    if payload.action not in ("approve", "reject", "hold"):
        raise HTTPException(status_code=422, detail="action must be approve, reject or hold")
    if not payload.ids:
        raise HTTPException(status_code=422, detail="ids list must not be empty")
    if len(payload.ids) > 100:
        raise HTTPException(status_code=422, detail="bulk action limited to 100 ids per call")

    action_map = {"approve": "approved", "reject": "rejected", "hold": "on_hold"}
    actual_action = action_map[payload.action]

    # BUG-APR-019 — wrap each request in a SAVEPOINT so a failure on one
    # id doesn't poison the shared session for the rest of the batch
    # (and so each successful action commits independently). Without this,
    # the first DB-level failure marked the whole connection as
    # "rollback-only" and subsequent succeeded[] entries lied — they got
    # rolled back when the request handler returned.
    succeeded = []
    failed = []
    # BUG-APR-019 — wrap each action in a SAVEPOINT so a single failure
    # doesn't poison the shared session for later iterations. SQLAlchemy
    # async `begin_nested()` issues SAVEPOINT under an autobegun outer
    # transaction; rollback() rewinds only the nested portion.
    for req_id in payload.ids:
        savepoint = None
        try:
            savepoint = await db.begin_nested()
        except Exception:
            savepoint = None
        try:
            action_req = ApprovalActionRequest(action=actual_action, comments=payload.comments)
            await process_action(request_id=req_id, payload=action_req, db=db, current_user=current_user)
            if savepoint is not None and savepoint.is_active:
                await savepoint.commit()
            succeeded.append(req_id)
        except HTTPException as e:
            if savepoint is not None and savepoint.is_active:
                try:
                    await savepoint.rollback()
                except Exception:
                    pass
            failed.append({"id": req_id, "error": e.detail})
        except Exception:
            if savepoint is not None and savepoint.is_active:
                try:
                    await savepoint.rollback()
                except Exception:
                    pass
            failed.append({"id": req_id, "error": "internal error"})

    if failed and not succeeded:
        # Honest summary: nothing got through.
        return {
            "success": False,
            "message": f"All {len(failed)} action(s) failed",
            "processed": 0,
            "succeeded": succeeded,
            "failed": failed,
        }
    return {
        "success": len(failed) == 0,
        "message": (
            f"{len(succeeded)} succeeded"
            + (f", {len(failed)} failed" if failed else "")
        ),
        "processed": len(succeeded),
        "succeeded": succeeded,
        "failed": failed,
    }


@router.get("/pending")
async def get_my_pending_approvals(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    document_type: str = Query(None),
    status: str = Query(None),
    search: str = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Get pending approval requests as paginated response for DataTable."""
    # Allow the inbox to ask for on_hold rows (via `?status=on_hold` or
    # `?status=pending,on_hold`). Without this, Hold makes the row vanish.
    want_on_hold = bool(status) and "on_hold" in status

    # 2026-05-06: Approved / Rejected history view. When the caller asks for
    # status=approved or status=rejected, an approver wants to see what THEY
    # have actioned, not the universe of approved/rejected docs. Pull from
    # approval_history where action_by = current_user.id.
    wanted_set = {s.strip() for s in (status or "").split(",") if s.strip()}
    history_only = bool(wanted_set) and wanted_set.issubset({"approved", "rejected"})
    if history_only:
        from app.models.approval import ApprovalHistory
        # Latest action per request that was taken by me, restricted to the
        # requested actions.
        hist_q = (
            select(ApprovalRequest)
            .options(
                selectinload(ApprovalRequest.history),
                selectinload(ApprovalRequest.requester),
            )
            .join(ApprovalHistory, ApprovalHistory.request_id == ApprovalRequest.id)
            .where(ApprovalHistory.action_by == current_user.id)
            .where(ApprovalHistory.action.in_(wanted_set))
            .order_by(ApprovalRequest.id.desc())
        )
        if document_type:
            hist_q = hist_q.where(ApprovalRequest.document_type == document_type)
        result = await db.execute(hist_q)
        pending = list({r.id: r for r in result.scalars().all()}.values())
    else:
        pending = await get_pending_approvals(
            db, current_user.id, include_on_hold=want_on_hold,
        )

        # Filter by approval status if requested (single value or csv).
        if status:
            wanted = {s.strip() for s in status.split(",") if s.strip()}
            if wanted:
                pending = [r for r in pending if r.status in wanted]

    # Filter by document_type if specified
    if document_type:
        pending = [r for r in pending if r.document_type == document_type]

    # Search by document_number
    if search:
        search_lower = search.lower()
        pending = [r for r in pending if search_lower in (r.document_number or "").lower()]

    total = len(pending)
    offset = (page - 1) * page_size
    page_items = pending[offset:offset + page_size]

    # Resolve user IDs to names
    user_ids = list(set(r.requested_by for r in page_items if r.requested_by))
    user_map = {}
    if user_ids:
        user_result = await db.execute(
            select(User.id, User.username, User.first_name, User.last_name)
            .where(User.id.in_(user_ids))
        )
        for row in user_result:
            name = f"{row.first_name or ''} {row.last_name or ''}".strip() or row.username
            user_map[row.id] = name

    # For history rows (approved/rejected by me), pull the level at which the
    # current user acted plus their actual action. Lets the UI render
    # "Sent to L2" instead of a generic green tick.
    my_action_map: dict[int, dict] = {}
    if history_only and page_items:
        from app.models.approval import ApprovalHistory
        ah_rows = await db.execute(
            select(ApprovalHistory)
            .where(ApprovalHistory.request_id.in_([r.id for r in page_items]))
            .where(ApprovalHistory.action_by == current_user.id)
            .order_by(ApprovalHistory.action_date.desc(), ApprovalHistory.id.desc())
        )
        for h in ah_rows.scalars().all():
            if h.request_id not in my_action_map:
                my_action_map[h.request_id] = {
                    "my_action": h.action,
                    "my_action_level": h.level,
                    "my_action_date": h.action_date.isoformat() if h.action_date else None,
                    "my_action_remarks": h.comments,
                }

    items = [{
        "id": r.id, "document_type": r.document_type, "document_id": r.document_id,
        "document_number": r.document_number, "current_level": r.current_level,
        "total_levels": r.total_levels, "status": r.status,
        "requested_by": r.requested_by,
        "requested_by_name": user_map.get(r.requested_by, str(r.requested_by) if r.requested_by else "-"),
        "requested_at": r.requested_at,
        **my_action_map.get(r.id, {}),
    } for r in page_items]

    return build_paginated_response(items, total, page, page_size)


@router.get("/history")
async def list_approval_history(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    status: str = Query(None),
    document_type: str = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Alias: GET /approvals/history -> delegates to /approvals/requests (returns all requests including completed)."""
    return await list_approval_requests(page=page, page_size=page_size, status=status, document_type=document_type, db=db, current_user=current_user)


@router.post("/requests/{request_id}/action")
async def process_action(
    request_id: int,
    payload: ApprovalActionRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Approve, reject, hold, or return an approval request."""
    # Super-admin / admin bypass — consistent with get_pending_approvals
    # which already returns every pending request to admins. Without this
    # bypass, admins could see the list but get 403 on click (2026-04-24).
    from app.utils.dependencies import get_user_role_codes
    role_codes = await get_user_role_codes(db, current_user.id)
    is_admin = bool({"super_admin", "admin"} & set(role_codes))
    used_admin_bypass = False
    if not await can_user_approve(db, request_id, current_user.id):
        if is_admin:
            used_admin_bypass = True
        else:
            raise HTTPException(status_code=403, detail="You are not authorized to act on this request")

    # BUG-IND-048 — when an admin acts on a request they aren't actually
    # the configured approver for, surface that in the history comments
    # so audit shows "admin override" rather than masquerading as a
    # normal level approval.
    effective_comments = payload.comments
    if used_admin_bypass:
        bypass_note = "[admin bypass — outside the configured approver chain]"
        effective_comments = (
            f"{payload.comments} {bypass_note}".strip()
            if payload.comments else bypass_note
        )

    # Apply per-line approved_qty overrides BEFORE process_approval_action
    # advances the request, so the writeback in indent_lifecycle uses the
    # approver's edits. Indent-only for now.
    if payload.action == "approved" and payload.item_overrides:
        await _apply_indent_qty_overrides(
            db, request_id, payload.item_overrides,
        )

    request = await process_approval_action(
        db, request_id, payload.action, current_user.id, effective_comments
    )

    # BUG-APR-048 — propagate on_hold to the source document too. Without
    # this, the ApprovalRequest sat in on_hold but the originating
    # indent/MR/PO still showed as pending_approval, so users had no
    # visibility that the workflow was paused.
    if request.status in ("approved", "rejected", "on_hold"):
        await _update_document_status(db, request.document_type, request.document_id, request.status, current_user.id)

    # 2026-05-06 — superseded: previously auto-created an MR if stock was
    # short. That removed the warehouse_manager's discretion (CENTRAL stock
    # might be earmarked for higher-priority demand, or timing dictates a
    # fresh procurement). The Demand Pool is the explicit decision point.
    await db.flush()
    return {"success": True, "message": f"Request {payload.action}", "status": request.status}


async def _auto_route_indent_after_approval_DISABLED(
    db: AsyncSession, indent_id: int, actor_user_id: int,
) -> Optional[dict]:
    """If the just-approved indent has a stock shortfall at the effective
    real warehouse, auto-create + submit an MR. Returns a dict describing
    the routing decision (mr_number / 'in_stock' / None) for the response.
    """
    from app.models.indent import Indent, IndentItem
    from app.models.warehouse import Warehouse as _Wh
    from app.models.stock import StockBalance
    from app.models.procurement import (
        MaterialRequest, MaterialRequestItem, MrIndentLink,
    )
    from app.services.number_series import generate_number as gen_num
    from decimal import Decimal

    ind_row = await db.execute(
        select(Indent)
        .options(selectinload(Indent.items))
        .where(Indent.id == indent_id)
    )
    indent = ind_row.scalar_one_or_none()
    if not indent or indent.status != "approved":
        return None

    # Resolve effective stock-source warehouse (vehicle → first non-virtual)
    wh_id = indent.warehouse_id
    if wh_id:
        wh = (await db.execute(
            select(_Wh).where(_Wh.id == wh_id)
        )).scalar_one_or_none()
        if wh and getattr(wh, "type", None) == "virtual":
            replacement = (await db.execute(
                select(_Wh.id)
                .where(_Wh.type.in_(("main", "regional")))
                .where(_Wh.is_active == True)
                .limit(1)
            )).scalar()
            if replacement:
                wh_id = replacement

    # Sum shortfall per item: max(0, approved - issued - available_at_wh)
    shortfall_lines: list[tuple] = []
    for line in indent.items:
        approved_q = Decimal(str(line.approved_qty or line.requested_qty or 0))
        issued_q = Decimal(str(line.issued_qty or 0))
        need = approved_q - issued_q
        if need <= 0:
            continue
        avail = Decimal("0")
        if wh_id:
            avail_row = await db.execute(
                select(func.coalesce(func.sum(StockBalance.available_qty), 0))
                .where(StockBalance.item_id == line.item_id)
                .where(StockBalance.warehouse_id == wh_id)
            )
            avail = Decimal(str(avail_row.scalar() or 0))
        gap = need - avail
        if gap > 0:
            shortfall_lines.append((line, gap))

    if not shortfall_lines:
        return {"action": "in_stock", "message": "Stock available — ready for Material Issue"}

    # Skip if an MR already exists for this indent
    existing_mr = (await db.execute(
        select(MaterialRequest)
        .where(MaterialRequest.indent_id == indent.id)
        .where(MaterialRequest.status.notin_(["cancelled", "rejected"]))
        .limit(1)
    )).scalar_one_or_none()
    if existing_mr is not None:
        return {"action": "mr_exists", "mr_number": existing_mr.mr_number}

    mr_number = await gen_num(db, "procurement", "material_request")
    mr = MaterialRequest(
        mr_number=mr_number,
        indent_id=indent.id,
        project_id=indent.project_id,
        warehouse_id=indent.warehouse_id,
        request_type="purchase",
        department=indent.department,
        requested_by=actor_user_id,
        request_date=datetime.now(timezone.utc),
        required_date=indent.required_date,
        priority="high",
        remarks=f"Auto-created on L2 approval of {indent.indent_number} (stock shortfall)",
    )
    db.add(mr)
    await db.flush()

    for line, gap in shortfall_lines:
        mr_item = MaterialRequestItem(
            mr_id=mr.id,
            item_id=line.item_id,
            qty=gap,
            uom_id=line.uom_id,
            remarks=f"From indent {indent.indent_number}",
        )
        db.add(mr_item)
        await db.flush()
        try:
            db.add(MrIndentLink(
                mr_id=mr.id, indent_id=indent.id,
                indent_item_id=line.id, mr_item_id=mr_item.id, qty=gap,
            ))
        except Exception:
            pass

    # Auto-submit so it lands in purchase_manager's inbox immediately
    try:
        from app.services.approval_service import submit_for_approval
        mr.status = "pending_approval"
        await submit_for_approval(
            db, "procurement", "material_request", mr.id, mr_number,
            actor_user_id, indent.project_id,
            department=getattr(mr, "department", None),
            request_type=getattr(mr, "request_type", None),
        )
    except Exception:
        import logging
        logging.getLogger(__name__).exception(
            "auto-submit failed for MR %s", mr_number,
        )

    return {"action": "mr_created", "mr_number": mr_number, "mr_id": mr.id}


async def _apply_indent_qty_overrides(
    db: AsyncSession,
    request_id: int,
    overrides: List[ApprovalItemOverride],
) -> None:
    """Persist per-line approved_qty edits before the workflow advances.

    Validates: each override.item_id must belong to the indent backing
    request_id, and approved_qty must be 0 < q <= requested_qty (we never
    let an approver grant *more* than was asked for — that's a new request).
    """
    if not overrides:
        return
    ar = (await db.execute(
        select(ApprovalRequest).where(ApprovalRequest.id == request_id)
    )).scalar_one_or_none()
    if not ar or ar.document_type != "indent":
        return
    from app.models.indent import IndentItem as _II
    rows = (await db.execute(
        select(_II).where(_II.indent_id == ar.document_id)
    )).scalars().all()
    by_id = {r.id: r for r in rows}
    for o in overrides:
        line = by_id.get(o.item_id)
        if not line:
            continue
        try:
            new_q = float(o.approved_qty or 0)
        except (TypeError, ValueError):
            continue
        if new_q < 0:
            continue
        max_q = float(line.requested_qty or 0)
        if max_q and new_q > max_q:
            new_q = max_q
        line.approved_qty = new_q


async def _fetch_document_detail(db, document_type: str, document_id: int):
    """Fetch source document detail for the approval drawer."""
    import importlib
    model_map = {
        "material_request": ("app.models.procurement", "MaterialRequest", "items", "MaterialRequestItem"),
        "purchase_order": ("app.models.procurement", "PurchaseOrder", "items", "PurchaseOrderItem"),
        "indent": ("app.models.indent", "Indent", "items", "IndentItem"),
        "stock_transfer": ("app.models.transfer", "StockTransfer", "items", "StockTransferItem"),
    }
    config = model_map.get(document_type)
    if not config:
        return None

    module = importlib.import_module(config[0])
    model_class = getattr(module, config[1])
    items_rel = config[2]
    line_item_class = getattr(module, config[3], None)

    from sqlalchemy.orm import selectinload as sload
    query = select(model_class).where(model_class.id == document_id)
    try:
        rel_attr = getattr(model_class, items_rel, None)
        if rel_attr is not None:
            # Chain selectinload to also load the Item master on each line item
            line_item_rel = getattr(line_item_class, "item", None) if line_item_class else None
            if line_item_rel is not None:
                query = query.options(sload(rel_attr).selectinload(line_item_rel))
            else:
                query = query.options(sload(rel_attr))
    except Exception:
        pass

    result = await db.execute(query)
    doc = result.scalar_one_or_none()
    if not doc:
        return None

    detail = {"remarks": getattr(doc, "remarks", None)}
    if hasattr(doc, "grand_total"):
        detail["grand_total"] = float(doc.grand_total) if doc.grand_total else None
    if hasattr(doc, "subtotal"):
        detail["subtotal"] = float(doc.subtotal) if doc.subtotal else None
    if hasattr(doc, "tax_amount"):
        detail["tax_total"] = float(doc.tax_amount) if doc.tax_amount else None

    items = []
    doc_items = getattr(doc, items_rel, None)

    # BUG-APR-046 — resolve uom_id integers to their UOM `name` so the
    # approval drawer shows "Box" / "Each" / "Litre" instead of "12".
    uom_id_set = {
        getattr(it, "uom_id", None)
        for it in (doc_items or [])
        if getattr(it, "uom_id", None)
    }
    uom_id_set.discard(None)
    uom_name_map: dict[int, str] = {}
    if uom_id_set:
        try:
            from app.models.master import UOM as _UOM
            urows = await db.execute(
                select(_UOM.id, _UOM.name).where(_UOM.id.in_(list(uom_id_set)))
            )
            for r in urows.all():
                uom_name_map[r[0]] = r[1]
        except Exception:
            uom_name_map = {}

    if doc_items:
        for item in doc_items:
            qty_val = getattr(item, "qty", None) or getattr(item, "requested_qty", None) or 0
            uom_id_val = getattr(item, "uom_id", None)
            item_data = {
                "id": item.id,
                "item_id": getattr(item, "item_id", None),
                "qty": float(qty_val) if qty_val else 0,
                "uom": uom_name_map.get(uom_id_val) or (
                    str(uom_id_val) if uom_id_val else None
                ),
                "remarks": getattr(item, "remarks", None),
            }
            if hasattr(item, "rate") and item.rate:
                item_data["rate"] = float(item.rate)
            if hasattr(item, "amount") and item.amount:
                item_data["amount"] = float(item.amount)
            # Try to get item name from relationship
            try:
                if hasattr(item, "item") and item.item:
                    item_data["item_name"] = getattr(item.item, "name", None)
                    item_data["item_code"] = getattr(item.item, "item_code", None)
            except Exception:
                pass
            items.append(item_data)

    # 2026-05-06: stock visibility for indent L2 approval. The L2 approver
    # (warehouse_manager) needs to know whether the warehouse can fulfil
    # the line BEFORE clicking Approve.
    #
    # 2026-05-06 (vehicle model): when the indents destination is a
    # virtual warehouse (vehicle / mobile unit), check stock at the main
    # source warehouse, NOT at the vehicle. Vehicles never hold persistent
    # inventory in the books — central holds it; vehicles consume out.
    if document_type == "indent":
        from app.models.warehouse import Warehouse as _Wh
        from app.models.stock import StockBalance
        wh_id = getattr(doc, "warehouse_id", None)
        if wh_id:
            wh_row = await db.execute(select(_Wh).where(_Wh.id == wh_id))
            wh_obj = wh_row.scalar_one_or_none()
            if wh_obj and getattr(wh_obj, "type", None) == "virtual":
                # Look up the first real (non-virtual) warehouse — usually
                # CENTRAL — and check stock there. In a multi-hub setup
                # this would scope by the approver's mapped warehouses.
                main_row = await db.execute(
                    select(_Wh.id)
                    .where(_Wh.type.in_(("main", "regional")))
                    .where(_Wh.is_active == True)
                    .limit(1)
                )
                replacement = main_row.scalar()
                if replacement:
                    wh_id = replacement
        item_ids = [it["item_id"] for it in items if it.get("item_id")]
        avail_map: dict[int, float] = {}
        if wh_id and item_ids:
            try:
                rows = await db.execute(
                    select(
                        StockBalance.item_id,
                        func.coalesce(func.sum(StockBalance.available_qty), 0),
                    )
                    .where(StockBalance.warehouse_id == wh_id)
                    .where(StockBalance.item_id.in_(item_ids))
                    .group_by(StockBalance.item_id)
                )
                for r in rows.all():
                    avail_map[int(r[0])] = float(r[1] or 0)
            except Exception:
                avail_map = {}
        in_stock_count = 0
        for it in items:
            iid = it.get("item_id")
            avail = float(avail_map.get(iid, 0)) if iid is not None else 0
            it["available_qty"] = avail
            req = float(it.get("qty") or 0)
            if avail >= req and req > 0:
                it["stock_status"] = "in_stock"
                in_stock_count += 1
            elif avail > 0:
                it["stock_status"] = "partial"
            else:
                it["stock_status"] = "no_stock"
        detail["stock_summary"] = {
            "in_stock_lines": in_stock_count,
            "total_lines": len(items),
            "warehouse_id": wh_id,
        }

    detail["items"] = items
    return detail


async def _update_document_status(db, document_type: str, document_id: int, status: str, user_id: int):
    """Update the source document status after approval/rejection.

    BUG-APR-047 — for indents, an `approved` outcome must run the indent
    lifecycle (stock check → auto-MI for in-stock lines, auto-MR for short
    lines). Previously this just stamped status='approved' and walked away,
    so the workflow-driven approval path silently skipped fulfillment.
    """
    from datetime import datetime, timezone
    # Indent + approved → defer to the lifecycle which already stamps status,
    # approved_by, approved_date and creates auto-MI / auto-MR.
    if document_type == "indent" and status == "approved":
        from app.services.indent_lifecycle import on_indent_approved
        # The lifecycle's BUG-IND-012 status guard expects pending_approval;
        # a workflow-completed indent should still be in pending_approval at
        # this point, since we only reach here when process_action transitioned
        # the ApprovalRequest from pending → approved.
        try:
            await on_indent_approved(db, indent_id=document_id, user_id=user_id)
        except HTTPException:
            # If the indent's status drifted (e.g., admin force-approved
            # earlier), fall through to the plain status stamp below so the
            # workflow doesn't deadlock.
            pass
        else:
            return

    model_map = {
        "material_request": ("app.models.procurement", "MaterialRequest"),
        "purchase_order": ("app.models.procurement", "PurchaseOrder"),
        "indent": ("app.models.indent", "Indent"),
        "stock_transfer": ("app.models.transfer", "StockTransfer"),
        "purchase_return": ("app.models.returns", "PurchaseReturn"),
        "quotation": ("app.models.procurement", "Quotation"),
    }
    # 2026-05-06 — quotation status enum doesn't include 'approved' /
    # 'pending_approval'. Map workflow outcomes onto the enum it does
    # accept: approved → accepted; rejected → rejected; on_hold → submitted.
    if document_type == "quotation":
        if status == "approved":
            status = "accepted"
        elif status == "on_hold":
            status = "submitted"
    config = model_map.get(document_type)
    if not config:
        return

    import importlib
    module = importlib.import_module(config[0])
    model_class = getattr(module, config[1])

    result = await db.execute(select(model_class).where(model_class.id == document_id))
    doc = result.scalar_one_or_none()
    # BUG-APR-049 — if the source document was deleted between submission
    # and approval, raise 404 instead of silently no-oping. Otherwise the
    # ApprovalRequest gets stamped approved/rejected but no document
    # change happens and the requester has no visible signal.
    if not doc:
        raise HTTPException(
            status_code=404,
            detail=(
                f"Source {document_type} #{document_id} no longer exists; "
                f"cannot apply status."
            ),
        )

    # BUG-APR-048 — `on_hold` isn't part of every source-doc status enum.
    # Map to a per-model status the document actually accepts; otherwise
    # SQLAlchemy raises a DataError on flush. For Indent/MR/PO we revert
    # to "pending_approval" so the doc stays in the in-flight state but
    # the engine is paused.
    target_status = status
    if status == "on_hold":
        target_status = "pending_approval"

    doc.status = target_status
    if hasattr(doc, "approved_by") and status == "approved":
        doc.approved_by = user_id
    if hasattr(doc, "approved_date") and status == "approved":
        doc.approved_date = datetime.now(timezone.utc)


# ============================================================================
# Approval delegations (Wave 1 of the configurable workflow engine)
# ============================================================================

class DelegationCreate(BaseModel):
    delegatee_id: int
    valid_from: datetime
    valid_to: datetime
    scope_module: Optional[str] = None  # null = all modules
    reason: Optional[str] = None

    @field_validator("valid_to")
    @classmethod
    def _val_window(cls, v, info):
        vf = info.data.get("valid_from")
        if vf and v <= vf:
            raise ValueError("valid_to must be after valid_from")
        return v


def _delegation_to_dict(d: ApprovalDelegation, users: dict) -> dict:
    return {
        "id": d.id,
        "delegator_id": d.delegator_id,
        "delegator_name": users.get(d.delegator_id),
        "delegatee_id": d.delegatee_id,
        "delegatee_name": users.get(d.delegatee_id),
        "valid_from": d.valid_from.isoformat() if d.valid_from else None,
        "valid_to": d.valid_to.isoformat() if d.valid_to else None,
        "scope_module": d.scope_module,
        "reason": d.reason,
        "is_active": d.is_active,
        "created_at": d.created_at.isoformat() if d.created_at else None,
        "revoked_at": d.revoked_at.isoformat() if d.revoked_at else None,
    }


async def _resolve_user_names(db: AsyncSession, user_ids: list) -> dict:
    if not user_ids:
        return {}
    result = await db.execute(select(User).where(User.id.in_(user_ids)))
    out = {}
    for u in result.scalars().all():
        # User SQLAlchemy model has first_name + last_name + username (no
        # full_name column — that's only on the API response schema).
        full = f"{u.first_name or ''} {u.last_name or ''}".strip() or u.username
        out[u.id] = full
    return out


@router.post("/delegations", status_code=201)
async def create_delegation(
    payload: DelegationCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Delegate the current user's incoming approvals to another user
    for a date window. Anyone can create their own delegation; admins
    can create on behalf of others by passing `delegator_id` (NOT exposed
    via this endpoint — use `/delegations/admin` for that)."""
    if payload.delegatee_id == current_user.id:
        raise HTTPException(status_code=400, detail="Cannot delegate to yourself")

    # Verify delegatee exists and is active
    result = await db.execute(select(User).where(User.id == payload.delegatee_id))
    delegatee = result.scalar_one_or_none()
    if not delegatee or not delegatee.is_active:
        raise HTTPException(status_code=404, detail="Delegatee not found or inactive")

    # BUG-APR-030 — refuse cyclic delegations (A→B then B→A, or longer
    # cycles A→B→C→A). Walk the active-delegation graph forward from the
    # proposed delegatee and bail if we ever land back on the delegator.
    # Cycles cause approvals to ping-pong between delegators forever and
    # eventually exhaust recursion in `delegated_user_ids_for`.
    visited: set[int] = {current_user.id}
    frontier: set[int] = {payload.delegatee_id}
    now = datetime.now(timezone.utc)
    while frontier:
        if current_user.id in frontier:
            raise HTTPException(
                status_code=400,
                detail=(
                    "Refusing to create a delegation that would form a "
                    "cycle (A→B→…→A). Revoke the conflicting delegation "
                    "first."
                ),
            )
        next_frontier: set[int] = set()
        rows = await db.execute(
            select(ApprovalDelegation.delegatee_id).where(
                ApprovalDelegation.delegator_id.in_(list(frontier)),
                ApprovalDelegation.is_active == True,  # noqa: E712
                ApprovalDelegation.valid_from <= now,
                # BUG-APR-028 — exclusive upper bound (see active_delegations_for).
                ApprovalDelegation.valid_to > now,
            )
        )
        for r in rows.all():
            uid = r[0]
            if uid not in visited:
                visited.add(uid)
                next_frontier.add(uid)
        frontier = next_frontier

    delegation = ApprovalDelegation(
        delegator_id=current_user.id,
        delegatee_id=payload.delegatee_id,
        valid_from=payload.valid_from,
        valid_to=payload.valid_to,
        scope_module=(payload.scope_module or None),
        reason=payload.reason,
        is_active=True,
    )
    db.add(delegation)
    await db.flush()

    names = await _resolve_user_names(db, [current_user.id, payload.delegatee_id])
    return {"success": True, "data": _delegation_to_dict(delegation, names)}


@router.get("/delegations")
async def list_delegations(
    direction: str = Query("mine_outgoing", regex="^(mine_outgoing|mine_incoming|all)$"),
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """List approval delegations.
      - `mine_outgoing` (default): delegations I've created (people I'm
        delegating my approvals to)
      - `mine_incoming`: delegations to me (people who've delegated to me)
      - `all`: super-admin only, returns every delegation

    BUG-APR-034 — added pagination. Previously this endpoint returned every
    matching row in one shot, which on `direction=all` could return tens of
    thousands of rows once delegations had been used for a few quarters.
    """
    base_q = None
    count_q = None
    if direction == "all":
        # BUG-APR-033 — UserRole was referenced before import. Import first,
        # then run the admin check, then query.
        from app.models.user import Role, UserRole
        admin_check = await db.execute(
            select(Role.code)
            .join(UserRole, UserRole.role_id == Role.id)
            .where(UserRole.user_id == current_user.id)
        )
        codes = {r[0] for r in admin_check.all()}
        if "super_admin" not in codes:
            raise HTTPException(status_code=403, detail="Admin only")
        base_q = select(ApprovalDelegation).order_by(ApprovalDelegation.created_at.desc())
        count_q = select(func.count(ApprovalDelegation.id))
    elif direction == "mine_incoming":
        base_q = (
            select(ApprovalDelegation)
            .where(ApprovalDelegation.delegatee_id == current_user.id)
            .order_by(ApprovalDelegation.created_at.desc())
        )
        count_q = select(func.count(ApprovalDelegation.id)).where(
            ApprovalDelegation.delegatee_id == current_user.id
        )
    else:  # mine_outgoing
        base_q = (
            select(ApprovalDelegation)
            .where(ApprovalDelegation.delegator_id == current_user.id)
            .order_by(ApprovalDelegation.created_at.desc())
        )
        count_q = select(func.count(ApprovalDelegation.id)).where(
            ApprovalDelegation.delegator_id == current_user.id
        )

    total = (await db.execute(count_q)).scalar() or 0
    offset = (page - 1) * page_size
    result = await db.execute(base_q.offset(offset).limit(page_size))
    rows = list(result.scalars().all())

    user_ids = list({d.delegator_id for d in rows} | {d.delegatee_id for d in rows})
    names = await _resolve_user_names(db, user_ids)
    return {
        "results": [_delegation_to_dict(d, names) for d in rows],
        "total": total,
        "page": page,
        "page_size": page_size,
    }


@router.delete("/delegations/{delegation_id}")
async def revoke_delegation(
    delegation_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Revoke a delegation. Owner or super_admin only."""
    result = await db.execute(
        select(ApprovalDelegation).where(ApprovalDelegation.id == delegation_id)
    )
    d = result.scalar_one_or_none()
    if not d:
        raise HTTPException(status_code=404, detail="Delegation not found")

    if d.delegator_id != current_user.id:
        # Allow super_admin override
        from app.models.user import Role, UserRole
        admin_check = await db.execute(
            select(Role.code)
            .join(UserRole, UserRole.role_id == Role.id)
            .where(UserRole.user_id == current_user.id)
        )
        codes = {r[0] for r in admin_check.all()}
        if "super_admin" not in codes:
            raise HTTPException(status_code=403, detail="Only the delegator or admin can revoke")

    d.is_active = False
    d.revoked_at = datetime.now(timezone.utc)

    # BUG-APR-032 — reroute any in-flight escalations that are sitting on
    # the delegatee. Without this, revoking a delegation leaves prior
    # escalations stuck pointing at the (now-undelegated) backup, which
    # silently undermines the revoke. Reset them to the original
    # escalation_user_id from the level config so the next escalation
    # scan can re-evaluate them cleanly.
    rerouted = 0
    try:
        affected = await db.execute(
            select(ApprovalRequest, ApprovalLevel)
            .join(
                ApprovalLevel,
                and_(
                    ApprovalLevel.workflow_id == ApprovalRequest.workflow_id,
                    ApprovalLevel.level == ApprovalRequest.current_level,
                ),
            )
            .where(ApprovalRequest.status == "pending")
            .where(ApprovalRequest.escalated_to_user_id == d.delegatee_id)
            .where(ApprovalLevel.escalation_user_id == d.delegator_id)
        )
        for req, lvl in affected.all():
            req.escalated_to_user_id = lvl.escalation_user_id
            db.add(ApprovalHistory(
                request_id=req.id,
                level=req.current_level,
                action="escalated",
                action_by=current_user.id,
                comments=(
                    f"Delegation {d.id} revoked — escalation rerouted "
                    f"back to user {lvl.escalation_user_id}"
                ),
            ))
            rerouted += 1
    except Exception:
        pass

    await db.flush()
    return {
        "success": True,
        "message": "Delegation revoked",
        "escalations_rerouted": rerouted,
    }


@router.get("/delegations/active")
async def my_active_delegations(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Returns the active delegations to me right now (so the UI can show
    'You're acting on behalf of: X, Y' in the header)."""
    rows = await active_delegations_for(db, current_user.id)
    user_ids = [d.delegator_id for d in rows]
    names = await _resolve_user_names(db, user_ids)
    return {
        "active_for": [
            {
                "delegation_id": d.id,
                "delegator_id": d.delegator_id,
                "delegator_name": names.get(d.delegator_id),
                "scope_module": d.scope_module,
                "valid_to": d.valid_to.isoformat() if d.valid_to else None,
            }
            for d in rows
        ],
        "count": len(rows),
    }


# ============================================================================
# SLA breaches + escalation processor (Wave 2 of the configurable engine)
# ============================================================================

@router.get("/sla-breaches")
async def list_sla_breaches(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Returns every pending approval whose current level has breached its
    configured `escalation_after_hours`. Includes both already-escalated
    requests and not-yet-escalated ones so the UI can surface "needs
    bumping" vs "already routed to backup".
    """
    breaches = await find_sla_breaches(db, only_unescalated=False)
    user_ids = list({b[0].requested_by for b in breaches}
                    | {b[1].escalation_user_id for b in breaches if b[1].escalation_user_id}
                    | {b[0].escalated_to_user_id for b in breaches if b[0].escalated_to_user_id})
    names = await _resolve_user_names(db, user_ids)

    return {
        "results": [
            {
                "request_id": req.id,
                "document_type": req.document_type,
                "document_id": req.document_id,
                "document_number": req.document_number,
                "current_level": req.current_level,
                "requested_by": req.requested_by,
                "requested_by_name": names.get(req.requested_by),
                "requested_at": req.requested_at.isoformat() if req.requested_at else None,
                "sla_hours": lvl.escalation_after_hours,
                "overdue_hours": round(overdue, 2),
                "escalation_user_id": lvl.escalation_user_id,
                "escalation_user_name": names.get(lvl.escalation_user_id),
                "already_escalated_to": req.escalated_to_user_id,
                "already_escalated_to_name": names.get(req.escalated_to_user_id),
                "escalated_at": req.escalated_at.isoformat() if req.escalated_at else None,
                "escalation_count": req.escalation_count or 0,
            }
            for (req, lvl, overdue) in breaches
        ],
        "total": len(breaches),
    }


class EscalationRunRequest(BaseModel):
    dry_run: bool = False


@router.post("/process-escalations")
async def run_escalation_pass(
    payload: EscalationRunRequest = EscalationRunRequest(),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_any_role("super_admin", "admin")),
):
    """Admin-triggered scan: walk every pending approval, escalate any
    that have breached SLA AND have an escalation target configured.
    Pass `{"dry_run": true}` to preview without writing.
    """
    summary = await process_escalations(
        db, actor_id=current_user.id, dry_run=payload.dry_run
    )
    return {"success": True, **summary}
