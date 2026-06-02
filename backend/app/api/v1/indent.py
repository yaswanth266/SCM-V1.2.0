from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from typing import List, Optional
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload
from datetime import datetime, timezone, timedelta
from decimal import Decimal
import json
from app.database import get_db
from app.models.user import User
from app.models.indent import Indent, IndentItem, IndentAcknowledgement, IndentAcknowledgementItem
from app.models.system import FileAttachment

# Per MoM 2026-04-19 §6: max 3 indents per requester per rolling 30-day window.
# Drafts don't count — only submitted/onward statuses.
# D-013: cap was 3/30days — operationally crippling for 26-district EMS doing
# hundreds of indents daily. Bumped to 200/day equivalent (~1000/30days). Can
# be made truly configurable via system_settings later.
import os
INDENT_SUBMISSION_CAP = int(os.environ.get("INDENT_SUBMISSION_CAP", "1000"))
INDENT_SUBMISSION_WINDOW_DAYS = int(os.environ.get("INDENT_SUBMISSION_WINDOW_DAYS", "30"))
from app.schemas.indent import (
    IndentCreate, IndentUpdate, IndentResponse,
    IndentAcknowledgementCreate, IndentAcknowledgementResponse, AckItemResponse,
)
from app.services.number_series import generate_number
from app.services.approval_service import submit_for_approval
from app.utils.dependencies import (
    get_current_user, require_any_role,
    user_is_managerial, user_warehouse_ids,
)
from app.utils.helpers import paginate_params, build_paginated_response, apply_search_filter

# Roles allowed to approve / reject indents.
# R-007 fix: field_supervisor (= Department Head per manual) and project_manager
# (= Doctor) added so they can approve indents from their dept.
# `require_any_role` additionally bypasses for super_admin.
APPROVER_ROLES = (
    "warehouse_manager", "purchase_manager", "admin", "store_keeper",
    "field_supervisor", "project_manager",
)
# Separation of duties (workflow rebuild 2026-04-30): approvers MUST NOT also
# be raisers. Specifically `field_supervisor` and `project_manager` are
# approval-only — letting them raise their own indents and then approve them
# defeats the whole control. So CREATOR_ROLES is hand-listed instead of
# union'd over APPROVER_ROLES.
CREATOR_ROLES = (
    "warehouse_manager", "admin", "store_keeper",
    "purchase_officer", "warehouse_operator", "field_staff",
)

# Main indent router — mounted at /indent/indents and /indents
router = APIRouter()

# Acknowledgement router — mounted at /indent
ack_router = APIRouter()


# ==================== INDENT CRUD ====================

@router.get("")
async def list_indents(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    search: str = Query(None),
    status: str = Query(None),
    indent_type: str = Query(None),
    warehouse_id: int = Query(None),
    project_id: int = Query(None),
    pending_acknowledgement: bool = Query(None),
    available_for_issue: bool = Query(
        None,
        description=(
            "When true, return only indents that still have unissued line "
            "qty — used by the Material Issue dropdown to hide already "
            "fully-issued indents and prevent duplicate MIs."
        ),
    ),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    offset, limit = paginate_params(page, page_size)
    query = select(Indent).options(
        selectinload(Indent.items).selectinload(IndentItem.item),
        selectinload(Indent.items).selectinload(IndentItem.uom),
        selectinload(Indent.warehouse),
        # Bug fix BUG_0042: include project so we can return project_name
        selectinload(Indent.project),
    )
    count_query = select(func.count(Indent.id))

    if status:
        query = query.where(Indent.status == status)
        count_query = count_query.where(Indent.status == status)
    if indent_type:
        query = query.where(Indent.indent_type == indent_type)
        count_query = count_query.where(Indent.indent_type == indent_type)
    if warehouse_id:
        query = query.where(Indent.warehouse_id == warehouse_id)
        count_query = count_query.where(Indent.warehouse_id == warehouse_id)
    if project_id:
        query = query.where(Indent.project_id == project_id)
        count_query = count_query.where(Indent.project_id == project_id)

    # Filter for indents pending acknowledgement (approved/fulfilled but not yet acknowledged)
    if pending_acknowledgement:
        query = query.where(
            Indent.status.in_(["approved", "partially_fulfilled", "fulfilled"])
        )
        count_query = count_query.where(
            Indent.status.in_(["approved", "partially_fulfilled", "fulfilled"])
        )

    # When the Material Issue page asks for issuable indents, scope to
    # approved/partially_fulfilled and exclude indents whose every line is
    # already fully issued (issued_qty >= max(approved_qty, requested_qty)).
    # Otherwise the dropdown lets two operators pick the same indent and
    # double-issue against it.
    if available_for_issue:
        query = query.where(
            Indent.status.in_(["approved", "partially_fulfilled"])
        )
        count_query = count_query.where(
            Indent.status.in_(["approved", "partially_fulfilled"])
        )
        # Subquery: indent_ids where AT LEAST ONE line still has quantity that
        # can be issued now.
        #
        # Normal issue path:
        #   approved/requested - issued > 0
        #
        # Partial acknowledgement path:
        #   if the raiser acknowledged only part of what was issued, the
        #   shortage should become issuable again. We only unlock this when
        #   acked > 0 so a fully-issued indent that is merely awaiting its
        #   first acknowledgement cannot be accidentally issued twice.
        from sqlalchemy import case as _sa_case
        approved_target = _sa_case(
            (IndentItem.approved_qty.is_not(None), IndentItem.approved_qty),
            else_=IndentItem.requested_qty,
        )
        issued_remaining = approved_target - func.coalesce(IndentItem.issued_qty, 0)
        acked_qty = func.coalesce(
            select(func.sum(IndentAcknowledgementItem.received_qty))
            .where(IndentAcknowledgementItem.indent_item_id == IndentItem.id)
            .scalar_subquery(),
            0,
        )
        ack_remaining = approved_target - acked_qty
        with_remaining = (
            select(IndentItem.indent_id)
            .where((issued_remaining > 0) | ((acked_qty > 0) & (ack_remaining > 0)))
            .group_by(IndentItem.indent_id)
        )
        query = query.where(Indent.id.in_(with_remaining))
        count_query = count_query.where(Indent.id.in_(with_remaining))

    # ACCESS SCOPING — strict role-based.
    # • Super admin / admin: see everything (org-wide).
    # • warehouse_manager / store_keeper: see ALL approved/partially_fulfilled
    #   indents org-wide. These roles physically issue material from main
    #   warehouses to FULFILL indents raised by field staff. The indent's
    #   warehouse_id is the DESTINATION (field vehicle / virtual warehouse),
    #   NOT the issuing warehouse. Scoping to their assigned warehouses would
    #   hide every field-staff indent they are responsible for fulfilling.
    # • purchase_manager: org-wide view for procurement coordination.
    # • Field-only roles (field_staff/field_user/etc.): ONLY their own indents.
    # • Other operator roles (warehouse_operator, etc.): own + assigned warehouse.
    _FIELD_ONLY_CODES = frozenset({
        "field_staff", "field_user", "field_operator",
        "nurse", "pharmacy_assistant", "site_user",
    })
    # Roles that need org-wide visibility to do their job properly.
    _ORG_WIDE_CODES = frozenset({
        "super_admin", "admin",
        "warehouse_manager", "store_keeper", "purchase_manager",
    })
    from app.utils.dependencies import get_user_role_codes
    role_codes = set(await get_user_role_codes(db, current_user.id))
    is_admin = bool(_ORG_WIDE_CODES & role_codes)
    if not is_admin:
        is_field_only = (
            bool(role_codes)
            and role_codes.issubset(_FIELD_ONLY_CODES)
        )
        if is_field_only:
            # Hard scope: only what the user themselves raised.
            query = query.where(Indent.raised_by == current_user.id)
            count_query = count_query.where(Indent.raised_by == current_user.id)
        else:
            # Operator / non-admin manager scope: own + warehouse-assigned
            # + project-assigned. Without an explicit warehouse mapping
            # they see only what they raised.
            wh_ids = await user_warehouse_ids(db, current_user.id)
            from sqlalchemy import or_
            scope = Indent.raised_by == current_user.id
            if wh_ids:
                scope = or_(scope, Indent.warehouse_id.in_(wh_ids))
            try:
                from app.models.user import UserProject
                up_rows = await db.execute(
                    select(UserProject.project_id).where(UserProject.user_id == current_user.id)
                )
                user_proj_ids = [r[0] for r in up_rows.all()]
                if user_proj_ids:
                    scope = or_(scope, Indent.project_id.in_(user_proj_ids))
            except Exception:
                pass
            query = query.where(scope)
            count_query = count_query.where(scope)


    query = apply_search_filter(query, Indent, search, ["indent_number", "department"])
    count_query = apply_search_filter(count_query, Indent, search, ["indent_number", "department"])

    total = (await db.execute(count_query)).scalar()
    result = await db.execute(query.offset(offset).limit(limit).order_by(Indent.id.desc()))
    indents = result.scalars().all()

    # Enrich each indent in pending_approval status with the current
    # workflow level + a boolean `can_approve_now` so the frontend can
    # hide the Approve button for users who aren't at the current level.
    # Without this the Approve click hits the API and returns a 403,
    # which is correct but a poor UX (users see a button they can't use).
    pa_indent_ids = [ind.id for ind in indents if ind.status == "pending_approval"]
    workflow_meta: dict = {}
    if pa_indent_ids:
        from app.models.approval import ApprovalRequest, ApprovalLevel
        from app.utils.dependencies import get_user_role_codes
        ar_rows = await db.execute(
            select(ApprovalRequest)
            .where(ApprovalRequest.document_type == "indent")
            .where(ApprovalRequest.document_id.in_(pa_indent_ids))
            .where(ApprovalRequest.status == "pending")
        )
        ars = ar_rows.scalars().all()
        if ars:
            level_keys = [(a.workflow_id, a.current_level) for a in ars]
            from sqlalchemy import tuple_ as _tuple
            lvl_rows = await db.execute(
                select(ApprovalLevel).where(
                    _tuple(ApprovalLevel.workflow_id, ApprovalLevel.level).in_(level_keys)
                )
            )
            lvl_by_key = {
                (l.workflow_id, l.level): l for l in lvl_rows.scalars().all()
            }
            user_role_codes = set(await get_user_role_codes(db, current_user.id))
            user_role_ids: set = set()
            try:
                from app.models.user import UserRole as _UR
                ur_rows = await db.execute(
                    select(_UR.role_id).where(_UR.user_id == current_user.id)
                )
                user_role_ids = {r[0] for r in ur_rows.all()}
            except Exception:
                pass
            is_admin_bypass = bool({"super_admin", "admin"} & user_role_codes)
            # Build a quick lookup of raised_by per indent so we can deny
            # the originator (admin overrides keep the original behavior).
            indent_raisers = {ind.id: ind.raised_by for ind in indents}
            for ar in ars:
                lvl = lvl_by_key.get((ar.workflow_id, ar.current_level))
                can_now = is_admin_bypass
                if lvl is not None and not can_now:
                    if lvl.approver_user_id == current_user.id:
                        can_now = True
                    elif lvl.approver_role_id and lvl.approver_role_id in user_role_ids:
                        can_now = True
                # Raiser cannot approve their own indent, even if their
                # role grants them L1 authority. Admins keep override.
                if (
                    not is_admin_bypass
                    and indent_raisers.get(ar.document_id) == current_user.id
                ):
                    can_now = False
                workflow_meta[ar.document_id] = {
                    "current_workflow_level": ar.current_level,
                    "total_workflow_levels": ar.total_levels,
                    "can_approve_now": bool(can_now),
                }

    # Resolve user display names for raised_by / approved_by in bulk
    all_user_ids = set()
    for ind in indents:
        if ind.raised_by:
            all_user_ids.add(ind.raised_by)
        if ind.approved_by:
            all_user_ids.add(ind.approved_by)
    
    user_map: dict[int, str] = {}
    if all_user_ids:
        from app.models.user import User as UserModel
        user_rows = await db.execute(select(UserModel).where(UserModel.id.in_(all_user_ids)))
        for u in user_rows.scalars().all():
            full = f"{u.first_name or ''} {u.last_name or ''}".strip() or u.username
            user_map[u.id] = full

    response_items = []
    for ind in indents:
        data = IndentResponse.model_validate(ind).model_dump()
        data["warehouse_name"] = ind.warehouse.name if ind.warehouse else None
        # Bug fix BUG_0042: surface project name for the list view column
        data["project_name"] = ind.project.name if ind.project else None
        data["raised_by_name"] = user_map.get(ind.raised_by)
        data["approved_by_name"] = user_map.get(ind.approved_by)
        # Workflow gating fields (None when no workflow / not pending).
        # `can_approve_now` defaults to False when workflow_meta is missing —
        # absence means we have no ApprovalRequest row to check the user
        # against, so the safe default is to hide the approve button. The
        # previous default-to-True leaked the button to every viewer
        # (including the indent's own raiser) on pending indents whose
        # ApprovalRequest hadn't been created yet or had been deleted.
        meta = workflow_meta.get(ind.id, {})
        data["current_workflow_level"] = meta.get("current_workflow_level")
        data["total_workflow_levels"] = meta.get("total_workflow_levels")
        data["can_approve_now"] = bool(meta.get("can_approve_now", False))
        for i, item in enumerate(ind.items):
            if i < len(data.get("items", [])):
                if item.item:
                    data["items"][i]["item_name"] = item.item.name
                    data["items"][i]["item_code"] = item.item.item_code
                if item.uom:
                    data["items"][i]["uom"] = item.uom.name
        response_items.append(data)
    return build_paginated_response(response_items, total, page, page_size)


@router.get("/{indent_id}")
async def get_indent(
    indent_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    result = await db.execute(
        select(Indent)
        .options(
            selectinload(Indent.items).selectinload(IndentItem.item),
            selectinload(Indent.items).selectinload(IndentItem.uom),
            selectinload(Indent.warehouse),
        )
        .where(Indent.id == indent_id)
    )
    indent = result.scalar_one_or_none()
    if not indent:
        raise HTTPException(status_code=404, detail="Indent not found")

    # Bug fix R-004 — originator must ALWAYS be able to see their own indent,
    # regardless of role/warehouse. Check that first before any other gates.
    is_originator = (indent.raised_by is not None and indent.raised_by == current_user.id)

    if not is_originator:
        # ACCESS SCOPING — strict role-based.
        # • Managerial roles: full visibility.
        # • Field-only roles: their own raised indents only (handled by
        #   is_originator above — anything reaching here is not theirs).
        # • Operator roles: warehouse-scoped.
        if not await user_is_managerial(db, current_user.id):
            from app.utils.dependencies import get_user_role_codes
            _FIELD_ONLY_CODES = frozenset({
                "field_staff", "field_supervisor", "field_user", "field_operator",
                "nurse", "pharmacy_assistant", "site_user",
            })
            role_codes = set(await get_user_role_codes(db, current_user.id))
            is_field_only = bool(role_codes) and role_codes.issubset(_FIELD_ONLY_CODES)
            if is_field_only:
                raise HTTPException(status_code=403, detail="Not authorized to view this indent")
            wh_ids = await user_warehouse_ids(db, current_user.id)
            if indent.warehouse_id not in wh_ids:
                raise HTTPException(status_code=403, detail="Not authorized to view this indent")

    data = IndentResponse.model_validate(indent).model_dump()
    data["warehouse_name"] = indent.warehouse.name if indent.warehouse else None

    # Resolve user display names for raised_by / approved_by so the UI shows
    # "Murali" instead of "2". Fetch both in one query.
    user_ids = {indent.raised_by, indent.approved_by} - {None}
    user_map: dict[int, str] = {}
    if user_ids:
        from app.models.user import User as UserModel
        result = await db.execute(select(UserModel).where(UserModel.id.in_(user_ids)))
        for u in result.scalars().all():
            full = f"{u.first_name or ''} {u.last_name or ''}".strip() or u.username
            user_map[u.id] = full
    data["raised_by_name"] = user_map.get(indent.raised_by)
    data["approved_by_name"] = user_map.get(indent.approved_by)

    item_ack_rows = await db.execute(
        select(
            IndentAcknowledgementItem.indent_item_id,
            func.coalesce(func.sum(IndentAcknowledgementItem.received_qty), 0),
        )
        .where(
            IndentAcknowledgementItem.indent_item_id.in_(
                [item.id for item in indent.items if item.id is not None]
            )
        )
        .group_by(IndentAcknowledgementItem.indent_item_id)
    )
    item_ack_map = {row[0]: float(row[1] or 0) for row in item_ack_rows.all()}

    # Workflow gating fields — kept in sync with list_indents above so the
    # detail page can hide the Approve button from the raiser and from
    # users who aren't the current-level approver. Defaults to False when
    # there's no ApprovalRequest row, never to True.
    data["current_workflow_level"] = None
    data["total_workflow_levels"] = None
    data["can_approve_now"] = False
    if indent.status == "pending_approval":
        from app.models.approval import ApprovalRequest, ApprovalLevel
        from app.utils.dependencies import get_user_role_codes
        ar_row = await db.execute(
            select(ApprovalRequest)
            .where(ApprovalRequest.document_type == "indent")
            .where(ApprovalRequest.document_id == indent.id)
            .where(ApprovalRequest.status == "pending")
            .limit(1)
        )
        ar = ar_row.scalar_one_or_none()
        if ar:
            data["current_workflow_level"] = ar.current_level
            data["total_workflow_levels"] = ar.total_levels
            lvl_row = await db.execute(
                select(ApprovalLevel)
                .where(ApprovalLevel.workflow_id == ar.workflow_id)
                .where(ApprovalLevel.level == ar.current_level)
                .limit(1)
            )
            lvl = lvl_row.scalar_one_or_none()
            user_role_codes = set(await get_user_role_codes(db, current_user.id))
            user_role_ids: set = set()
            try:
                from app.models.user import UserRole as _UR
                ur_rows = await db.execute(
                    select(_UR.role_id).where(_UR.user_id == current_user.id)
                )
                user_role_ids = {r[0] for r in ur_rows.all()}
            except Exception:
                pass
            is_admin_bypass = bool({"super_admin", "admin"} & user_role_codes)
            can_now = is_admin_bypass
            if lvl is not None and not can_now:
                if lvl.approver_user_id == current_user.id:
                    can_now = True
                elif lvl.approver_role_id and lvl.approver_role_id in user_role_ids:
                    can_now = True
            # Never allow the raiser to approve their own indent, even if
            # their role happens to match the current level.
            if indent.raised_by == current_user.id:
                can_now = False
            data["can_approve_now"] = bool(can_now)

    for i, item in enumerate(indent.items):
        if i < len(data.get("items", [])):
            approved_target = item.approved_qty if item.approved_qty is not None else item.requested_qty
            target_qty = float(approved_target or 0)
            issued_qty = float(item.issued_qty or 0)
            acknowledged_qty = item_ack_map.get(item.id, 0.0)
            issued_remaining_qty = max(target_qty - issued_qty, 0.0)
            ack_remaining_qty = max(target_qty - acknowledged_qty, 0.0)
            effective_issue_qty = (
                ack_remaining_qty
                if acknowledged_qty > 0 and ack_remaining_qty > issued_remaining_qty
                else issued_remaining_qty
            )
            data["items"][i]["acknowledged_qty"] = acknowledged_qty
            data["items"][i]["issue_remaining_qty"] = effective_issue_qty
            if item.item:
                data["items"][i]["item_name"] = item.item.name
                data["items"][i]["item_code"] = item.item.item_code
                # Enrich with master flags so MI prefill can decide whether
                # batch is mandatory and what rate to seed.
                data["items"][i]["has_batch"] = bool(getattr(item.item, "has_batch", False))
                pp = getattr(item.item, "purchase_price", None)
                data["items"][i]["purchase_price"] = float(pp) if pp is not None else 0.0
                data["items"][i]["rate"] = float(pp) if pp is not None else 0.0
            if item.uom:
                data["items"][i]["uom"] = item.uom.name
                data["items"][i]["uom_name"] = item.uom.name

    # Linked documents — Material Issues and Material Requests tied to this indent
    from app.models.issue import MaterialIssue
    from app.models.procurement import MaterialRequest as MRModel

    mi_rows = await db.execute(
        select(MaterialIssue.id, MaterialIssue.issue_number, MaterialIssue.status)
        .where(MaterialIssue.indent_id == indent_id)
        .order_by(MaterialIssue.id)
    )
    data["material_issues"] = [
        {"id": r[0], "issue_number": r[1], "status": r[2]} for r in mi_rows.all()
    ]

    mr_rows = await db.execute(
        select(MRModel.id, MRModel.mr_number, MRModel.status)
        .where(MRModel.indent_id == indent_id)
        .order_by(MRModel.id)
    )
    data["material_requests"] = [
        {"id": r[0], "mr_number": r[1], "status": r[2]} for r in mr_rows.all()
    ]

    # Acknowledgement flag — has this indent been acknowledged by the raiser?
    from app.models.indent import IndentAcknowledgement as IndentAck
    ack_check = await db.execute(
        select(IndentAck.id).where(IndentAck.indent_id == indent_id).limit(1)
    )
    data["is_acknowledged"] = ack_check.scalar_one_or_none() is not None

    # Approval history — surface action / user / timestamp / comments so the
    # detail tab can show who rejected, with what reason, at which level.
    # Without this the History tab was always empty even when approval_history
    # had rows.
    from app.models.approval import ApprovalRequest, ApprovalHistory
    from app.models.user import User as UserModel
    ah_rows = await db.execute(
        select(
            ApprovalHistory.id,
            ApprovalHistory.level,
            ApprovalHistory.action,
            ApprovalHistory.action_date,
            ApprovalHistory.comments,
            UserModel.username,
            UserModel.first_name,
            UserModel.last_name,
        )
        .join(ApprovalRequest, ApprovalRequest.id == ApprovalHistory.request_id)
        .join(UserModel, UserModel.id == ApprovalHistory.action_by)
        .where(ApprovalRequest.document_type == "indent")
        .where(ApprovalRequest.document_id == indent_id)
        .order_by(ApprovalHistory.action_date.asc(), ApprovalHistory.id.asc())
    )
    data["approval_history"] = [
        {
            "id": r[0],
            "level": r[1],
            "action": r[2],
            "timestamp": r[3].isoformat() if r[3] else None,
            "remarks": r[4],
            "user_name": (f"{r[6] or ''} {r[7] or ''}".strip() or r[5]),
        }
        for r in ah_rows.all()
    ]

    return data


@router.post("", status_code=201)
async def create_indent(
    payload: IndentCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_any_role(*CREATOR_ROLES)),
):
    if not payload.items:
        raise HTTPException(status_code=422, detail="At least one item is required")
    indent_number = await generate_number(db, "indent", "indent")
    department = payload.department or payload.department_id or None
    indent_date = payload.indent_date or datetime.now().date()

    # Auto-fill warehouse_id and project_id from the user's assignments when
    # the client didn't send them. Single-assignment users (the common case
    # for field staff) don't need to pick from a dropdown of one.
    warehouse_id = payload.warehouse_id
    project_id = payload.project_id
    if warehouse_id is None:
        wh_ids = await user_warehouse_ids(db, current_user.id)
        if len(wh_ids) == 1:
            warehouse_id = wh_ids[0]
    if project_id is None:
        from app.models.user import UserProject
        proj_rows = await db.execute(
            select(UserProject.project_id).where(UserProject.user_id == current_user.id)
        )
        proj_ids = [r[0] for r in proj_rows.all()]
        if len(proj_ids) == 1:
            project_id = proj_ids[0]
    if warehouse_id is None:
        raise HTTPException(
            status_code=422,
            detail="warehouse_id is required (no single warehouse mapped to your account)",
        )

    indent = Indent(
        indent_number=indent_number,
        project_id=project_id,
        warehouse_id=warehouse_id,
        indent_date=indent_date,
        required_date=payload.required_date,
        department=department,
        indent_type=payload.indent_type,
        remarks=payload.remarks,
        raised_by=current_user.id,
    )
    db.add(indent)
    await db.flush()

    from app.models.master import Item
    for item in payload.items:
        uom_id = item.uom_id
        if not uom_id:
            item_result = await db.execute(select(Item).where(Item.id == item.item_id))
            found_item = item_result.scalar_one_or_none()
            if found_item:
                uom_id = found_item.primary_uom_id
        ii = IndentItem(
            indent_id=indent.id, item_id=item.item_id,
            requested_qty=item.requested_qty, uom_id=uom_id,
            remarks=item.remarks,
        )
        db.add(ii)

    await db.flush()
    return {"id": indent.id, "indent_number": indent_number, "message": "Indent created"}


@router.put("/{indent_id}")
async def update_indent(
    indent_id: int,
    payload: IndentUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    result = await db.execute(select(Indent).where(Indent.id == indent_id))
    indent = result.scalar_one_or_none()
    if not indent:
        raise HTTPException(status_code=404, detail="Indent not found")

    # BUG-IND-053 — scope check. Only the originator, super_admin/admin, or
    # users mapped to the indent's warehouse may edit it.
    from app.utils.dependencies import get_user_role_codes
    role_codes = set(await get_user_role_codes(db, current_user.id))
    is_admin = bool({"super_admin", "admin"} & role_codes)
    is_originator = indent.raised_by == current_user.id
    if not (is_admin or is_originator):
        wh_ids = await user_warehouse_ids(db, current_user.id)
        if indent.warehouse_id not in wh_ids:
            raise HTTPException(
                status_code=403,
                detail="Not authorized to update this indent",
            )

    payload_data = payload.model_dump(exclude_unset=True)
    new_items = payload_data.pop("items", None)

    # BUG-IND-009 — only drafts may be edited. Previously scalar fields
    # (warehouse_id, required_date, indent_type, remarks) silently mutated
    # in any state. Items had a separate guard but headers did not.
    if indent.status != "draft":
        raise HTTPException(
            status_code=400,
            detail=(
                "Indent is not in draft status — only drafts can be edited."
            ),
        )

    # Defensive: even though IndentUpdate.status is no longer exposed
    # (BUG-IND-010), strip any sneaky pass-through.
    payload_data.pop("status", None)

    # BUG-IND-020 — refuse a wipe-via-empty-list. Updating with items=[]
    # would previously delete every line and leave a zero-item indent
    # which then can't be submitted (and worse, MIs / MRs already linked
    # would dangle). Items=None still means "leave items alone".
    if new_items is not None and len(new_items) == 0:
        raise HTTPException(
            status_code=400,
            detail="An indent must have at least one item",
        )

    for k, v in payload_data.items():
        setattr(indent, k, v)

    if new_items is not None:
        from app.models.master import Item
        # BUG-IND-022 — validate every item_id resolves to an existing,
        # active master item. Without this, a stale or attacker-supplied
        # item_id silently writes a dangling row that later breaks stock
        # check / issue / GRN flows.
        new_item_ids = list({i["item_id"] for i in new_items if i.get("item_id")})
        valid_items: dict[int, Item] = {}
        if new_item_ids:
            rows = await db.execute(
                select(Item).where(Item.id.in_(new_item_ids))
            )
            valid_items = {it.id: it for it in rows.scalars().all()}
        missing = [iid for iid in new_item_ids if iid not in valid_items]
        if missing:
            raise HTTPException(
                status_code=400,
                detail=f"Item(s) not found in master: {missing}",
            )
        inactive = [
            iid for iid, it in valid_items.items()
            if hasattr(it, "is_active") and getattr(it, "is_active") is False
        ]
        if inactive:
            raise HTTPException(
                status_code=400,
                detail=f"Item(s) are deactivated: {inactive}",
            )

        # Delete existing line items, then insert the replacement set.
        await db.execute(
            IndentItem.__table__.delete().where(IndentItem.indent_id == indent.id)
        )
        for item in new_items:
            uom_id = item.get("uom_id")
            if not uom_id:
                found_item = valid_items.get(item["item_id"])
                if found_item:
                    uom_id = found_item.primary_uom_id
            db.add(IndentItem(
                indent_id=indent.id,
                item_id=item["item_id"],
                requested_qty=item["requested_qty"],
                uom_id=uom_id,
                remarks=item.get("remarks"),
            ))

    await db.flush()
    return {"success": True, "message": "Indent updated"}


@router.post("/{indent_id}/submit")
async def submit_indent(
    indent_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    # BUG-IND-003 — take a row lock so two concurrent submit calls can't
    # both transition the same draft.
    result = await db.execute(
        select(Indent)
        .options(selectinload(Indent.items))
        .where(Indent.id == indent_id)
        .with_for_update()
    )
    indent = result.scalar_one_or_none()
    if not indent:
        raise HTTPException(status_code=404, detail="Indent not found")
    if indent.status != "draft":
        raise HTTPException(status_code=400, detail="Only draft indents can be submitted")

    # BUG-IND-019 — refuse submission if no items exist on the indent.
    if not indent.items or len(indent.items) == 0:
        raise HTTPException(
            status_code=400,
            detail="Cannot submit an indent with zero items",
        )

    # BUG-IND-001 — RBAC guard. Only the originator or super_admin/admin
    # may submit a draft indent. Without this, any authenticated user
    # could submit anyone else's draft.
    from app.utils.dependencies import get_user_role_codes
    role_codes = set(await get_user_role_codes(db, current_user.id))
    is_admin = bool({"super_admin", "admin"} & role_codes)
    is_originator = indent.raised_by == current_user.id
    if not (is_admin or is_originator):
        raise HTTPException(
            status_code=403,
            detail="You are not authorized to submit this indent",
        )

    # BUG-IND-029 — warehouse must exist and be active. A submission against
    # a deactivated warehouse should be refused at submit time, not silently
    # propagated through approval and stock check.
    from app.models.warehouse import Warehouse as _Wh
    wh_row = await db.execute(select(_Wh).where(_Wh.id == indent.warehouse_id))
    wh = wh_row.scalar_one_or_none()
    if not wh:
        raise HTTPException(status_code=400, detail="Indent warehouse not found")
    if not wh.is_active:
        raise HTTPException(
            status_code=400,
            detail="Indent warehouse is inactive — cannot submit",
        )

    # Attachment no longer mandatory (2026-04-24 — reverted MoM 2026-04-19 §6).

    # BUG-IND-002 — throttle by the originator (raised_by), not the actor
    # who clicked the button. Otherwise an admin submitting on behalf of
    # a user counts against the admin's cap, not the user's.
    window_start = datetime.now(timezone.utc) - timedelta(
        days=INDENT_SUBMISSION_WINDOW_DAYS
    )
    submitted_count = await db.scalar(
        select(func.count(Indent.id))
        .where(Indent.raised_by == indent.raised_by)
        .where(Indent.status != "draft")
        .where(Indent.created_at >= window_start)
    )
    if submitted_count is not None and submitted_count >= INDENT_SUBMISSION_CAP:
        raise HTTPException(
            status_code=429,
            detail=(
                f"Indent submission limit reached: max "
                f"{INDENT_SUBMISSION_CAP} indents in the last "
                f"{INDENT_SUBMISSION_WINDOW_DAYS} days. Try again later."
            ),
        )

    indent.status = "pending_approval"

    # BUG-APR-013 — de-dup: if a pending ApprovalRequest already exists for
    # this (doc_type, doc_id), don't create another one. This can happen if
    # a prior submit attempt rolled back partially or a retry slipped past
    # the row lock above.
    from app.models.approval import ApprovalRequest as _AR
    existing = await db.execute(
        select(_AR)
        .where(_AR.document_type == "indent")
        .where(_AR.document_id == indent.id)
        .where(_AR.status == "pending")
        .limit(1)
    )
    approval = existing.scalar_one_or_none()
    if approval is None:
        # BUG-APR-010 — pass an amount so amount-gated levels filter
        # correctly. Indent has no native total_value column, so we
        # estimate it as Σ(requested_qty * standard_rate) where the
        # standard_rate lives on items.standard_rate. If we can't compute,
        # we fall through with amount=0 (still better than None, which
        # made every amount-bounded level match every indent).
        try:
            from app.models.master import Item as _Item
            line_items = indent.items or []
            item_ids = [li.item_id for li in line_items if li.item_id]
            rate_map: dict[int, Decimal] = {}
            if item_ids:
                rate_rows = await db.execute(
                    select(_Item.id, _Item.purchase_price).where(_Item.id.in_(item_ids))
                )
                for r in rate_rows.all():
                    rate_map[r[0]] = Decimal(str(r[1] or 0))
            indent_amount = sum(
                (Decimal(str(li.requested_qty or 0)) * rate_map.get(li.item_id, Decimal("0")))
                for li in line_items
            )
            indent_amount = float(indent_amount)
        except Exception:
            indent_amount = 0.0

        approval = await submit_for_approval(
            db, "indent", "indent", indent.id, indent.indent_number,
            indent.raised_by, indent.project_id,
            amount=indent_amount,
            department=indent.department,
            request_type=indent.indent_type,
        )
    if not approval:
        raise HTTPException(
            status_code=400,
            detail="No approval workflow configured for indents. Please configure one in Approvals > Workflows."
        )

    # BUG-AUD-001 — record submit in activity_logs.
    try:
        from app.models.system import ActivityLog
        db.add(ActivityLog(
            user_id=current_user.id,
            module="indent",
            action="submit",
            entity_type="indent",
            entity_id=indent.id,
            description=f"Indent {indent.indent_number} submitted for approval",
        ))
    except Exception:
        pass

    await db.flush()
    return {"success": True, "message": "Indent submitted for approval", "approval_id": approval.id}


class ApproveIndentPayload(BaseModel):
    """Optional body for /indents/{id}/approve. The Indents.jsx approve modal
    sends per-line approved_qty overrides; without this schema the backend
    silently discarded them (BUG-FE-IND-005)."""
    items: Optional[List[dict]] = None


@router.post("/{indent_id}/approve")
async def approve_indent(
    indent_id: int,
    payload: ApproveIndentPayload = ApproveIndentPayload(),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_any_role(*APPROVER_ROLES)),
):
    """Wave 11C — approve fires the lifecycle: stock check + auto-issue/auto-MR.

    BUG-IND-004: gate on status=='pending_approval' so the lifecycle can't
    re-fire from drafts, rejected, fulfilled, or already-approved indents
    (which previously re-created MI/MR on every call).

    BUG-IND-005: if a configured approval workflow still has an open
    request for this indent, refuse the direct-approve shortcut — callers
    must walk the configured workflow via /approvals/requests/{id}/action.
    """
    # Verify indent exists and is in the right state.
    indent_row = await db.execute(select(Indent).where(Indent.id == indent_id))
    indent = indent_row.scalar_one_or_none()
    if not indent:
        raise HTTPException(status_code=404, detail="Indent not found")
    if indent.status != "pending_approval":
        raise HTTPException(
            status_code=400,
            detail=f"Only indents in pending_approval can be approved (current status: {indent.status})",
        )

    # BUG-IND-006 — separation of duties: the originator can never approve
    # their own indent, even if they hold an APPROVER_ROLES role. Super
    # admin keeps the override (escape hatch).
    from app.utils.dependencies import get_user_role_codes
    _role_codes = set(await get_user_role_codes(db, current_user.id))
    if indent.raised_by == current_user.id and "super_admin" not in _role_codes:
        raise HTTPException(
            status_code=403,
            detail="You cannot approve an indent you raised yourself",
        )

    # If a configured approval workflow still has an open request, route
    # the click into the workflow engine instead of forcing the user to
    # navigate to a different page. The engine still enforces the
    # level-by-level approver gate via can_user_approve, so a warehouse_
    # manager clicking Approve on an indent currently at the
    # field_supervisor level will get a clean 403 from process_action
    # ("not authorized to act on this request") rather than a confusing
    # 400 telling them to switch pages. (BUG-IND-005 originally routed
    # 400 here; that left the indent's Approve button broken whenever a
    # workflow was configured, even for the actually-correct approver.)
    from app.models.approval import ApprovalRequest
    open_req_row = await db.execute(
        select(ApprovalRequest)
        .where(ApprovalRequest.document_type == "indent")
        .where(ApprovalRequest.document_id == indent_id)
        .where(ApprovalRequest.status == "pending")
        .limit(1)
    )
    open_req = open_req_row.scalar_one_or_none()
    if open_req is not None:
        from app.services.approval_service import (
            can_user_approve, process_approval_action,
        )
        admin_bypass = bool({"super_admin", "admin"} & _role_codes)
        if not await can_user_approve(db, open_req.id, current_user.id) and not admin_bypass:
            raise HTTPException(
                status_code=403,
                detail=(
                    "You are not authorized to act on this approval at the "
                    "current level. Check the Approvals → Pending queue for "
                    "the correct approver."
                ),
            )
        comments = "[approved from Indents page]"
        if admin_bypass and not await can_user_approve(db, open_req.id, current_user.id):
            comments = "[admin bypass — approved from Indents page]"
        request_obj = await process_approval_action(
            db, open_req.id, "approved", current_user.id, comments,
        )
        # If the workflow is now finished, the document_status updater
        # inside process_action would have moved the indent to approved
        # already. We surface the workflow status to the caller so the
        # frontend can show "advanced to next level" vs "fully approved".
        await db.flush()
        return {
            "success": True,
            "message": (
                "Indent approved." if request_obj.status == "approved"
                else f"Approved at level {open_req.current_level}; awaiting next level."
            ),
            "workflow_status": request_obj.status,
            "current_level": request_obj.current_level,
        }

    # BUG-FE-IND-005 — apply per-line approved_qty overrides from the
    # approve modal. Without this, every line was approved at requested_qty
    # regardless of what the approver typed in the modal.
    if payload and payload.items:
        line_rows = await db.execute(
            select(IndentItem).where(IndentItem.indent_id == indent_id)
        )
        line_by_id = {l.id: l for l in line_rows.scalars().all()}
        for it in payload.items:
            line_id = it.get("id")
            target = line_by_id.get(line_id)
            if not target:
                continue
            qty = it.get("approved_qty")
            if qty is None:
                continue
            try:
                qty_dec = Decimal(str(qty))
                if qty_dec < 0:
                    continue
                # Cap at requested_qty — approver shouldn't be able to grant
                # more than the originator asked for.
                requested = Decimal(str(target.requested_qty or 0))
                if qty_dec > requested:
                    qty_dec = requested
                target.approved_qty = qty_dec
            except Exception:
                continue
        await db.flush()

    from app.services.indent_lifecycle import on_indent_approved
    summary = await on_indent_approved(db, indent_id=indent_id, user_id=current_user.id)

    # BUG-AUD-001 — record approval in activity_logs.
    try:
        from app.models.system import ActivityLog
        db.add(ActivityLog(
            user_id=current_user.id,
            module="indent",
            action="approve",
            entity_type="indent",
            entity_id=indent_id,
            description=f"Indent {indent.indent_number} approved",
        ))
    except Exception:
        pass
    msg_parts = ["Indent approved."]
    if summary.get("auto_issue_id"):
        msg_parts.append(f"Material Issue auto-created (id={summary['auto_issue_id']}) for {summary['lines_fulfillable']} line(s) in stock.")
    if summary.get("lines_short", 0) > 0:
        msg_parts.append(f"{summary['lines_short']} short line(s) — Purchase Manager will raise MR manually.")
    return {"success": True, "message": " ".join(msg_parts), **summary}


@router.post("/{indent_id}/reject")
async def reject_indent(
    indent_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_any_role(*APPROVER_ROLES)),
):
    result = await db.execute(select(Indent).where(Indent.id == indent_id))
    indent = result.scalar_one_or_none()
    if not indent:
        raise HTTPException(status_code=404, detail="Indent not found")

    # BUG-IND-007 — only pending_approval indents can be rejected. Rejecting
    # a draft, fulfilled, or already-rejected indent corrupts state.
    if indent.status != "pending_approval":
        raise HTTPException(
            status_code=400,
            detail=(
                f"Only indents in pending_approval can be rejected "
                f"(current status: {indent.status})"
            ),
        )

    # BUG-IND-006 — same separation-of-duties rule as approve.
    from app.utils.dependencies import get_user_role_codes
    _role_codes = set(await get_user_role_codes(db, current_user.id))
    if indent.raised_by == current_user.id and "super_admin" not in _role_codes:
        raise HTTPException(
            status_code=403,
            detail="You cannot reject an indent you raised yourself",
        )

    indent.status = "rejected"
    # BUG-IND-018 — preserve any prior approver/date history. We don't want
    # rejection to overwrite the audit fields if a previous level had
    # approved this indent before another rejected it.
    if not indent.approved_by:
        indent.approved_by = current_user.id
    if not indent.approved_date:
        indent.approved_date = datetime.now(timezone.utc)

    # BUG-IND-008 — update the linked ApprovalRequest. Previously the
    # indent-level reject left the ApprovalRequest dangling in 'pending',
    # so the request continued to show in pending queues forever.
    from app.models.approval import ApprovalRequest, ApprovalHistory
    open_req_row = await db.execute(
        select(ApprovalRequest)
        .where(ApprovalRequest.document_type == "indent")
        .where(ApprovalRequest.document_id == indent_id)
        .where(ApprovalRequest.status == "pending")
        .with_for_update()
    )
    open_req = open_req_row.scalar_one_or_none()
    if open_req is not None:
        open_req.status = "rejected"
        open_req.completed_at = datetime.now(timezone.utc)
        db.add(ApprovalHistory(
            request_id=open_req.id,
            level=open_req.current_level,
            action="rejected",
            action_by=current_user.id,
            comments="Rejected via /indent/{id}/reject",
        ))

    # BUG-AUD-001 — audit row.
    try:
        from app.models.system import ActivityLog
        db.add(ActivityLog(
            user_id=current_user.id,
            module="indent",
            action="reject",
            entity_type="indent",
            entity_id=indent_id,
            description=f"Indent {indent.indent_number} rejected",
        ))
    except Exception:
        pass

    await db.flush()
    return {"success": True, "message": "Indent rejected"}


@router.post("/{indent_id}/cancel")
async def cancel_indent(
    indent_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """BUG-IND-021 — the `cancelled` enum was wired into the model and the
    UI dropdown filter, but no endpoint existed. Originator (or admin) can
    cancel an indent that hasn't progressed past approval; once stock has
    been issued or fulfilled, cancellation is a separate flow (returns).
    """
    result = await db.execute(
        select(Indent).where(Indent.id == indent_id).with_for_update()
    )
    indent = result.scalar_one_or_none()
    if not indent:
        raise HTTPException(status_code=404, detail="Indent not found")

    # Only originator or admin/super_admin may cancel. Approvers don't get
    # this — their tool is /reject.
    from app.utils.dependencies import get_user_role_codes
    role_codes = set(await get_user_role_codes(db, current_user.id))
    is_admin = bool({"super_admin", "admin"} & role_codes)
    is_originator = indent.raised_by == current_user.id
    if not (is_admin or is_originator):
        raise HTTPException(
            status_code=403,
            detail="Only the originator (or admin) can cancel an indent",
        )

    if indent.status not in ("draft", "pending_approval"):
        raise HTTPException(
            status_code=400,
            detail=(
                f"Cannot cancel an indent in status '{indent.status}' — "
                f"only draft or pending_approval indents can be cancelled"
            ),
        )

    indent.status = "cancelled"

    # Cancel any open ApprovalRequest tied to this indent so it stops
    # showing in pending queues. Mirrors the BUG-IND-008 reject path.
    from app.models.approval import ApprovalRequest, ApprovalHistory
    open_req_row = await db.execute(
        select(ApprovalRequest)
        .where(ApprovalRequest.document_type == "indent")
        .where(ApprovalRequest.document_id == indent_id)
        .where(ApprovalRequest.status == "pending")
        .with_for_update()
    )
    open_req = open_req_row.scalar_one_or_none()
    if open_req is not None:
        open_req.status = "cancelled"
        open_req.completed_at = datetime.now(timezone.utc)
        db.add(ApprovalHistory(
            request_id=open_req.id,
            level=open_req.current_level,
            action="rejected",
            action_by=current_user.id,
            comments="Indent cancelled by originator/admin",
        ))

    try:
        from app.models.system import ActivityLog
        db.add(ActivityLog(
            user_id=current_user.id,
            module="indent",
            action="cancel",
            entity_type="indent",
            entity_id=indent_id,
            description=f"Indent {indent.indent_number} cancelled",
        ))
    except Exception:
        pass

    await db.flush()
    return {"success": True, "message": "Indent cancelled"}


@router.post("/{indent_id}/acknowledge", status_code=201)
async def acknowledge_indent_legacy(
    indent_id: int,
    payload: IndentAcknowledgementCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Legacy per-indent acknowledge endpoint."""
    payload.indent_id = indent_id
    return await _create_acknowledgement(payload, db, current_user)


@router.get("/{indent_id}/acknowledgements")
async def list_indent_acknowledgements(
    indent_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    # BUG-IND-045 — verify the caller can see the parent indent before
    # exposing its acknowledgement history.
    parent_row = await db.execute(select(Indent).where(Indent.id == indent_id))
    parent = parent_row.scalar_one_or_none()
    if not parent:
        raise HTTPException(status_code=404, detail="Indent not found")
    if parent.raised_by != current_user.id:
        if not await user_is_managerial(db, current_user.id):
            wh_ids = await user_warehouse_ids(db, current_user.id)
            if parent.warehouse_id not in wh_ids:
                raise HTTPException(
                    status_code=403,
                    detail="Not authorized to view this indent's acknowledgements",
                )

    result = await db.execute(
        select(IndentAcknowledgement)
        .options(
            selectinload(IndentAcknowledgement.acknowledger),
            selectinload(IndentAcknowledgement.items),
        )
        .where(IndentAcknowledgement.indent_id == indent_id)
    )
    acks = result.scalars().all()
    response = []
    for ack in acks:
        total_recv = sum((ai.received_qty or 0) for ai in ack.items) if ack.items else (ack.received_qty or 0)
        response.append({
            "id": ack.id,
            "indent_id": ack.indent_id,
            "acknowledged_by": ack.acknowledged_by,
            "acknowledged_by_name": (
                f"{ack.acknowledger.first_name or ''} {ack.acknowledger.last_name or ''}".strip()
                or ack.acknowledger.username
            ) if ack.acknowledger else None,
            "acknowledged_at": ack.acknowledged_at,
            "received_qty": total_recv,
            "status": ack.status or "received",
            "remarks": ack.remarks,
        })
    return response


@router.post("/{indent_id}/convert-to-mr", status_code=201)
async def convert_indent_to_mr(
    indent_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_any_role(*APPROVER_ROLES)),
):
    """Convert an approved indent to a Material Request when stock is not available.

    BUG-IND-014 — role-gated: only APPROVER_ROLES (purchase/warehouse
    managers, store_keeper, etc.) can perform the conversion. Previously
    every authenticated user could call this and create MRs.
    """
    from app.models.procurement import MaterialRequest, MaterialRequestItem
    from app.services.number_series import generate_number as gen_num

    # BUG-IND-003 / BUG-IND-015 — row-lock the indent so two concurrent
    # convert calls can't each create their own MR.
    result = await db.execute(
        select(Indent).options(
            selectinload(Indent.items).selectinload(IndentItem.item),
        ).where(Indent.id == indent_id).with_for_update()
    )
    indent = result.scalar_one_or_none()
    if not indent:
        raise HTTPException(status_code=404, detail="Indent not found")
    # BUG-IND-017 — also allow `partially_fulfilled` (lifecycle has issued
    # some lines and the rest still need to go to procurement). Keeping
    # only `approved` here meant a partially-stocked indent could never be
    # routed to MR for the shortfall — it would silently sit forever.
    if indent.status not in ("approved", "partially_fulfilled"):
        raise HTTPException(
            status_code=400,
            detail=(
                f"Only approved (or partially fulfilled) indents can be "
                f"converted to MR (current status: {indent.status})"
            ),
        )

    # BUG-IND-046 — scope check: caller must be admin / managerial OR mapped
    # to the indent's warehouse. APPROVER_ROLES includes officers who shouldn't
    # be raising MRs against warehouses they aren't assigned to.
    from app.utils.dependencies import get_user_role_codes
    role_codes = set(await get_user_role_codes(db, current_user.id))
    is_admin = bool({"super_admin", "admin"} & role_codes)
    if not is_admin:
        wh_ids = await user_warehouse_ids(db, current_user.id)
        if indent.warehouse_id not in wh_ids:
            raise HTTPException(
                status_code=403,
                detail="Not authorized to convert this indent (warehouse out of scope)",
            )

    # BUG-IND-015 — dedup. If an MR already exists linked to this indent
    # (auto-created by the lifecycle, or a prior manual convert), refuse
    # rather than creating a parallel MR. We only block on MRs that aren't
    # cancelled / rejected so that re-running convert after a cancelled MR
    # is still allowed.
    existing_mr_row = await db.execute(
        select(MaterialRequest)
        .where(MaterialRequest.indent_id == indent.id)
        .where(MaterialRequest.status.notin_(["cancelled", "rejected"]))
        .limit(1)
    )
    existing_mr = existing_mr_row.scalar_one_or_none()
    if existing_mr is not None:
        raise HTTPException(
            status_code=400,
            detail=(
                f"A Material Request ({existing_mr.mr_number}) already exists "
                f"for this indent. Cannot create a duplicate."
            ),
        )

    # BUG-IND-016 — pre-compute the procurement shortfall (approved minus
    # already-issued) before persisting an MR shell. Previously the
    # conversion always used `approved_qty or requested_qty`, so a
    # partially-fulfilled indent (some stock already pulled via auto-MI)
    # would have its full approved qty re-procured.
    shortfall_lines: list[tuple] = []
    for item in indent.items:
        approved = Decimal(str(item.approved_qty or item.requested_qty or 0))
        issued = Decimal(str(item.issued_qty or 0))
        qty = max(Decimal("0"), approved - issued)
        if qty > 0:
            shortfall_lines.append((item, qty))

    if not shortfall_lines:
        raise HTTPException(
            status_code=400,
            detail=(
                "Nothing to procure: every line on this indent has already "
                "been fully issued."
            ),
        )

    mr_number = await gen_num(db, "procurement", "material_request")
    mr = MaterialRequest(
        mr_number=mr_number,
        indent_id=indent.id,
        project_id=indent.project_id,
        warehouse_id=indent.warehouse_id,
        request_type="purchase",
        department=indent.department,
        requested_by=current_user.id,
        request_date=datetime.now(timezone.utc),
        required_date=indent.required_date,
        priority="high",
        remarks=f"Auto-created from {indent.indent_number}",
    )
    db.add(mr)
    await db.flush()

    # BUG-IND-013 — link to demand-pool junction so reverse traceability
    # works (indent → MR is recorded as a row in mr_indent_links, not just
    # the MaterialRequest.indent_id back-pointer that gets clobbered when
    # MRs are consolidated across multiple indents).
    from app.models.procurement import MrIndentLink as _MrIndentLink
    for ind_item, qty in shortfall_lines:
        mr_item = MaterialRequestItem(
            mr_id=mr.id, item_id=ind_item.item_id,
            qty=qty, uom_id=ind_item.uom_id,
            remarks=f"From indent {indent.indent_number}",
        )
        db.add(mr_item)
        await db.flush()
        try:
            db.add(_MrIndentLink(
                mr_id=mr.id,
                indent_id=indent.id,
                indent_item_id=ind_item.id,
                mr_item_id=mr_item.id,
                qty=qty,
            ))
        except Exception:
            # Junction is best-effort; legacy data may not have the table.
            pass

    # BUG-AUD-001 — audit row for conversion.
    try:
        from app.models.system import ActivityLog
        db.add(ActivityLog(
            user_id=current_user.id,
            module="indent",
            action="convert_to_mr",
            entity_type="indent",
            entity_id=indent.id,
            description=(
                f"Indent {indent.indent_number} converted to MR {mr_number}"
            ),
        ))
    except Exception:
        pass

    # 2026-05-06: auto-submit the MR so the warehouse manager who clicked
    # convert is registered as the requester. Without this, the MR sat as
    # 'draft' until a procurement_manager clicked Submit — which then
    # tagged THEM as requested_by, blocking them from approving at L2 of
    # the MR workflow due to separation-of-duties. The convert-to-mr action
    # already implies "send this to procurement", so submitting in the same
    # transaction matches the intent.
    try:
        from app.services.approval_service import submit_for_approval
        mr.status = "pending_approval"
        await submit_for_approval(
            db, "procurement", "material_request", mr.id, mr_number,
            current_user.id, indent.project_id,
            department=getattr(mr, "department", None),
            request_type=getattr(mr, "request_type", None),
        )
    except Exception:
        # If no workflow is configured for MRs, leave the MR in draft and
        # surface that to the caller rather than 500'ing the convert.
        import logging
        logging.getLogger(__name__).exception(
            "auto-submit failed for MR %s", mr_number,
        )

    await db.flush()
    return {
        "id": mr.id, "mr_number": mr_number,
        "message": f"Material Request {mr_number} created from {indent.indent_number} and submitted for approval",
    }


# ==================== ACKNOWLEDGEMENT ROUTES (ack_router, mounted at /indent) ====================

@ack_router.get("/acknowledgements")
async def list_all_acknowledgements(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    search: str = Query(None),
    status: str = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """List all indent acknowledgements with pagination."""
    offset, limit = paginate_params(page, page_size)
    query = (
        select(IndentAcknowledgement)
        .options(
            selectinload(IndentAcknowledgement.indent).selectinload(Indent.warehouse),
            selectinload(IndentAcknowledgement.acknowledger),
            selectinload(IndentAcknowledgement.items).selectinload(IndentAcknowledgementItem.item),
        )
    )
    count_query = select(func.count(IndentAcknowledgement.id))

    if status:
        query = query.where(IndentAcknowledgement.status == status)
        count_query = count_query.where(IndentAcknowledgement.status == status)

    if search:
        query = query.join(Indent).where(Indent.indent_number.ilike(f"%{search}%"))
        count_query = count_query.join(Indent).where(Indent.indent_number.ilike(f"%{search}%"))

    # BUG-IND-044 — IDOR: list_all_acknowledgements previously returned every
    # acknowledgement system-wide to any authenticated user. Scope down to:
    # managerial/admin sees all; everyone else sees only acks for indents
    # they raised or for warehouses they're mapped to.
    if not await user_is_managerial(db, current_user.id):
        from sqlalchemy import or_ as _or
        wh_ids = await user_warehouse_ids(db, current_user.id)
        # Need to join Indent (some rows already do via search). Re-join is
        # idempotent in SQLAlchemy when using `.join` on the same target.
        ack_scope = Indent.raised_by == current_user.id
        if wh_ids:
            ack_scope = _or(ack_scope, Indent.warehouse_id.in_(wh_ids))
        if not search:
            query = query.join(Indent)
            count_query = count_query.join(Indent)
        query = query.where(ack_scope)
        count_query = count_query.where(ack_scope)

    total = (await db.execute(count_query)).scalar()
    result = await db.execute(query.offset(offset).limit(limit).order_by(IndentAcknowledgement.id.desc()))
    acks = result.scalars().all()

    response_items = []
    for ack in acks:
        total_recv = sum((ai.received_qty or 0) for ai in ack.items) if ack.items else (ack.received_qty or 0)
        data = {
            "id": ack.id,
            "indent_id": ack.indent_id,
            "indent_number": ack.indent.indent_number if ack.indent else None,
            "warehouse_name": ack.indent.warehouse.name if ack.indent and ack.indent.warehouse else None,
            "acknowledged_by": ack.acknowledged_by,
            "acknowledged_by_name": (
                f"{ack.acknowledger.first_name or ''} {ack.acknowledger.last_name or ''}".strip()
                or ack.acknowledger.username
            ) if ack.acknowledger else None,
            "acknowledged_at": ack.acknowledged_at,
            "received_items_count": len(ack.items) if ack.items else (1 if ack.received_qty else 0),
            "total_received_qty": total_recv,
            "status": ack.status or "received",
            "remarks": ack.remarks,
        }
        response_items.append(data)
    return build_paginated_response(response_items, total, page, page_size)


@ack_router.get("/acknowledgements/{ack_id}")
async def get_acknowledgement(
    ack_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Get acknowledgement detail with items."""
    result = await db.execute(
        select(IndentAcknowledgement)
        .options(
            selectinload(IndentAcknowledgement.indent).selectinload(Indent.warehouse),
            selectinload(IndentAcknowledgement.indent).selectinload(Indent.items).selectinload(IndentItem.item),
            selectinload(IndentAcknowledgement.indent).selectinload(Indent.items).selectinload(IndentItem.uom),
            selectinload(IndentAcknowledgement.acknowledger),
            selectinload(IndentAcknowledgement.items).selectinload(IndentAcknowledgementItem.item),
            selectinload(IndentAcknowledgement.items).selectinload(IndentAcknowledgementItem.indent_item),
        )
        .where(IndentAcknowledgement.id == ack_id)
    )
    ack = result.scalar_one_or_none()
    if not ack:
        raise HTTPException(status_code=404, detail="Acknowledgement not found")

    # BUG-IND-043 — IDOR fix: caller must be the acknowledger, the indent's
    # raiser, managerial/admin, or mapped to the indent's warehouse.
    parent_indent = ack.indent
    if (
        ack.acknowledged_by != current_user.id
        and (parent_indent is None or parent_indent.raised_by != current_user.id)
    ):
        if not await user_is_managerial(db, current_user.id):
            wh_ids = await user_warehouse_ids(db, current_user.id)
            if not parent_indent or parent_indent.warehouse_id not in wh_ids:
                raise HTTPException(
                    status_code=403,
                    detail="Not authorized to view this acknowledgement",
                )

    items_data = []
    for ai in (ack.items or []):
        ind_item = ai.indent_item
        item_data = {
            "id": ai.id,
            "item_id": ai.item_id,
            "indent_item_id": ai.indent_item_id,
            "received_qty": ai.received_qty,
            "remarks": ai.remarks,
            "item_code": ai.item.item_code if ai.item else None,
            "item_name": ai.item.name if ai.item else None,
            "uom": ind_item.uom.name if ind_item and ind_item.uom else None,
            "approved_qty": ind_item.approved_qty if ind_item else None,
        }
        items_data.append(item_data)

    scanned_barcodes = []
    if ack.scanned_barcodes_json:
        try:
            scanned_barcodes = json.loads(ack.scanned_barcodes_json)
        except (json.JSONDecodeError, TypeError):
            pass

    total_recv = sum((ai.received_qty or 0) for ai in (ack.items or [])) if ack.items else (ack.received_qty or 0)

    return {
        "id": ack.id,
        "indent_id": ack.indent_id,
        "indent_number": ack.indent.indent_number if ack.indent else None,
        "warehouse_name": ack.indent.warehouse.name if ack.indent and ack.indent.warehouse else None,
        "acknowledged_by": ack.acknowledged_by,
        "acknowledged_by_name": (
            f"{ack.acknowledger.first_name or ''} {ack.acknowledger.last_name or ''}".strip()
            or ack.acknowledger.username
        ) if ack.acknowledger else None,
        "acknowledged_at": ack.acknowledged_at,
        "status": ack.status or "received",
        "remarks": ack.remarks,
        "scan_timestamp": ack.scan_timestamp,
        "received_items_count": len(items_data),
        "total_received_qty": total_recv,
        "scanned_barcodes": scanned_barcodes,
        "items": items_data,
    }


@ack_router.post("/acknowledgements", status_code=201)
async def create_acknowledgement_endpoint(
    payload: IndentAcknowledgementCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Create a new indent acknowledgement with items and barcode scans."""
    return await _create_acknowledgement(payload, db, current_user)


# ==================== SHARED HELPER ====================

async def _create_acknowledgement(
    payload: IndentAcknowledgementCreate,
    db: AsyncSession,
    current_user: User,
):
    """Shared logic for creating an acknowledgement."""
    # BUG-IND-003-style row lock so two concurrent acks can't simultaneously
    # transition status to "fulfilled" or both register as "first" complete.
    result = await db.execute(
        select(Indent)
        .options(selectinload(Indent.items))
        .where(Indent.id == payload.indent_id)
        .with_for_update()
    )
    indent = result.scalar_one_or_none()
    if not indent:
        raise HTTPException(status_code=404, detail="Indent not found")
    if indent.status not in ("approved", "partially_fulfilled", "fulfilled"):
        raise HTTPException(status_code=400, detail="Indent is not in a valid state for acknowledgement")

    # BUG-IND-051 — once an indent has a `completed` ack on file, refuse
    # additional ack rows. Otherwise the same indent can receive several
    # "completed" entries from different users / scans, all claiming the
    # full received_qty, which trashes the cumulative roll-up below.
    completed_existing = await db.execute(
        select(func.count(IndentAcknowledgement.id))
        .where(IndentAcknowledgement.indent_id == payload.indent_id)
        .where(IndentAcknowledgement.status == "completed")
    )
    if (completed_existing.scalar() or 0) > 0:
        raise HTTPException(
            status_code=400,
            detail=(
                "This indent has already been fully acknowledged. No "
                "further acknowledgements are accepted."
            ),
        )

    # BUG-IND-049 — anyone-authenticated could previously acknowledge any
    # indent. Restrict to: the indent's raiser, managerial/admin, or users
    # mapped to the indent's warehouse.
    is_raiser = indent.raised_by == current_user.id
    if not is_raiser:
        if not await user_is_managerial(db, current_user.id):
            wh_ids = await user_warehouse_ids(db, current_user.id)
            if indent.warehouse_id not in wh_ids:
                raise HTTPException(
                    status_code=403,
                    detail="Not authorized to acknowledge this indent",
                )

    # BUG-IND-050 — cap each line's received_qty at the approved/issued amount
    # so users can't acknowledge more than what was authorized. Also prevent
    # negative or zero quantities. Only enforced when explicit per-line items
    # are provided (legacy single-qty payload still falls through).
    if payload.items:
        # Build a lookup of indent line targets keyed by indent_item_id and item_id
        line_target = {}
        for ind_item in indent.items:
            target = ind_item.approved_qty or ind_item.requested_qty or Decimal("0")
            line_target[("id", ind_item.id)] = target
            line_target[("item", ind_item.item_id)] = target
        for ai in payload.items:
            if ai.received_qty is None or ai.received_qty < 0:
                raise HTTPException(
                    status_code=422,
                    detail="received_qty must be zero or positive",
                )
            tgt = (
                line_target.get(("id", ai.indent_item_id))
                if ai.indent_item_id
                else None
            )
            if tgt is None:
                tgt = line_target.get(("item", ai.item_id))
            if tgt is not None and ai.received_qty > tgt:
                raise HTTPException(
                    status_code=400,
                    detail=(
                        "Acknowledged quantity exceeds approved/issued amount "
                        "for at least one line"
                    ),
                )

    total_received = sum(item.received_qty for item in payload.items) if payload.items else (payload.received_qty or Decimal("0"))

    barcodes_json = None
    if payload.scanned_barcodes:
        barcodes_json = json.dumps([b.model_dump() for b in payload.scanned_barcodes])

    # Determine status
    ack_status = "received"
    if payload.items:
        all_received = True
        for ack_item in payload.items:
            for ind_item in indent.items:
                if ind_item.id == ack_item.indent_item_id or ind_item.item_id == ack_item.item_id:
                    target = ind_item.approved_qty or ind_item.requested_qty or 0
                    if ack_item.received_qty < target:
                        all_received = False
                    break
        ack_status = "completed" if all_received else "partial"

    ack = IndentAcknowledgement(
        indent_id=payload.indent_id,
        acknowledged_by=current_user.id,
        acknowledged_at=datetime.now(timezone.utc),
        received_qty=total_received,
        status=ack_status,
        remarks=payload.remarks,
        scan_barcode=payload.scan_barcode,
        scan_timestamp=datetime.now(timezone.utc) if (payload.scan_timestamp or payload.scanned_barcodes) else None,
        scanned_barcodes_json=barcodes_json,
    )
    db.add(ack)
    await db.flush()

    for item in payload.items:
        ack_item = IndentAcknowledgementItem(
            acknowledgement_id=ack.id,
            indent_item_id=item.indent_item_id,
            item_id=item.item_id,
            received_qty=item.received_qty,
            remarks=item.remarks,
        )
        db.add(ack_item)

        # Update IndentItem fulfillment status
        if item.indent_item_id:
            for ind_item in indent.items:
                if ind_item.id == item.indent_item_id:
                    ind_item.fulfillment_status = "acknowledged"
                    db.add(ind_item)

    # BUG-IND-052 — advance the parent indent's status when an ack
    # completes the order. We aggregate every prior ack on this indent
    # plus the lines we just added, and:
    #   - if every line's cumulative received >= approved/requested → fulfilled
    #   - else if anything has been received → partially_fulfilled
    # Status is only advanced forwards (approved → partial → fulfilled).
    try:
        all_acks_row = await db.execute(
            select(IndentAcknowledgement)
            .options(selectinload(IndentAcknowledgement.items))
            .where(IndentAcknowledgement.indent_id == indent.id)
        )
        cum: dict[int, Decimal] = {}
        for a in all_acks_row.scalars().all():
            for ai in (a.items or []):
                key = ai.indent_item_id or 0
                cum[key] = cum.get(key, Decimal("0")) + Decimal(str(ai.received_qty or 0))
        # Include the just-added items (they may not yet be flushed-as-loaded)
        for it in payload.items:
            key = it.indent_item_id or 0
            cum[key] = cum.get(key, Decimal("0"))  # already counted above on flush
        all_lines_complete = True
        any_received = False
        for ind_item in indent.items:
            target = Decimal(str(ind_item.approved_qty or ind_item.requested_qty or 0))
            recv = cum.get(ind_item.id, Decimal("0"))
            if recv > 0:
                any_received = True
            if recv < target:
                all_lines_complete = False
        if all_lines_complete and indent.items:
            indent.status = "fulfilled"
        elif any_received and indent.status == "approved":
            indent.status = "partially_fulfilled"
    except Exception:
        # Status-advancement is best-effort; never let it block the ack itself.
        pass

    # Route status to respective logistics dispatch (MDO) and MaterialIssue
    try:
        from app.models.logistics import LogisticsMainDispatchOrder
        from app.models.issue import MaterialIssue

        res_mdo = await db.execute(
            select(LogisticsMainDispatchOrder)
            .where(LogisticsMainDispatchOrder.indent_id == indent.id)
            .where(LogisticsMainDispatchOrder.status.in_(["IN_TRANSIT", "COMPLETED", "DISPATCHED"]))
        )
        mdos = res_mdo.scalars().all()
        for mdo in mdos:
            mdo.status = "ACKNOWLEDGED"
            db.add(mdo)

            # Record activity log for logistics dispatch update
            from app.models.system import ActivityLog
            db.add(ActivityLog(
                user_id=current_user.id,
                module="logistics",
                action="mdo_acknowledged",
                entity_type="dispatch",
                entity_id=mdo.id,
                description=f"Dispatch plan {mdo.mdo_number} acknowledged via indent portal receipt."
            ))

            # Set the linked Material Issue to 'acknowledged'
            if mdo.material_issue_id:
                res_mi = await db.execute(
                    select(MaterialIssue).where(MaterialIssue.id == mdo.material_issue_id)
                )
                mi = res_mi.scalar_one_or_none()
                if mi and mi.status not in ("acknowledged", "completed"):
                    mi.status = "acknowledged"
                    db.add(mi)
    except Exception as e:
        import logging
        logging.getLogger(__name__).exception("Failed to update linked logistics dispatch to ACKNOWLEDGED.")

    # BUG-AUD-001 — record acknowledgement in activity_logs.
    try:
        from app.models.system import ActivityLog
        db.add(ActivityLog(
            user_id=current_user.id,
            module="indent",
            action="acknowledge",
            entity_type="indent",
            entity_id=indent.id,
            description=(
                f"Indent {indent.indent_number} acknowledged "
                f"(ack id={ack.id}, status={ack_status})"
            ),
        ))
    except Exception:
        pass

    await db.flush()
    return {"id": ack.id, "status": ack_status, "message": "Acknowledgement recorded successfully"}
