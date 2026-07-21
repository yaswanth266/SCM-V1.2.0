from datetime import datetime, timezone
from typing import Optional, List, Set
from sqlalchemy import select, and_, or_
from sqlalchemy.ext.asyncio import AsyncSession
from app.models.approval import (
    ApprovalWorkflow, ApprovalLevel, ApprovalRequest, ApprovalHistory,
    ApprovalDelegation,
)
from app.models.user import UserRole, Role


async def get_position_ancestors(db: AsyncSession, position_id: int) -> List:
    from app.models.settings_master import Position
    from sqlalchemy import text
    ancestors = []
    visited = set()
    to_visit = [position_id]
    
    while to_visit:
        curr_id = to_visit.pop(0)
        if curr_id in visited:
            continue
        visited.add(curr_id)
        
        # Get parents from position_reporting junction table
        try:
            parent_res = await db.execute(
                text("SELECT parent_position_id FROM position_reporting WHERE position_id = :pos_id"),
                {"pos_id": curr_id}
            )
            parent_ids = [r[0] for r in parent_res.all()]
        except Exception:
            parent_ids = []
            
        # Fallback to legacy parent_position_id if junction table has no entries
        if not parent_ids:
            pos_res = await db.execute(select(Position.parent_position_id).where(Position.id == curr_id))
            legacy_parent = pos_res.scalar()
            if legacy_parent:
                parent_ids = [legacy_parent]
                
        for pid in parent_ids:
            if pid not in visited:
                res = await db.execute(select(Position).where(Position.id == pid))
                parent_pos = res.scalar_one_or_none()
                if parent_pos:
                    ancestors.append(parent_pos)
                    to_visit.append(pid)
                    
    return ancestors


async def get_position_descendants(db: AsyncSession, position_id: int) -> List:
    from app.models.settings_master import Position
    descendants = []
    to_visit = [position_id]
    visited = set()
    while to_visit:
        curr_id = to_visit.pop(0)
        if curr_id in visited:
            continue
        visited.add(curr_id)
        res = await db.execute(select(Position).where(Position.parent_position_id == curr_id))
        children = res.scalars().all()
        for child in children:
            descendants.append(child)
            to_visit.append(child.id)
    return descendants


async def get_hierarchical_active_position(db: AsyncSession, request, level_num: int):
    from app.models.user import User
    from app.models.settings_master import Employee, Position
    from app.models.approval import ProjectWorkflowConfig, ApprovalWorkflow
    
    user_q = await db.execute(select(User).where(User.id == request.requested_by))
    user = user_q.scalar_one_or_none()
    if not user or not user.employee_id:
        return None
    emp_q = await db.execute(select(Employee).where(Employee.id == user.employee_id))
    emp = emp_q.scalar_one_or_none()
    if not emp or not emp.position_id:
        return None
        
    # Get project_id from workflow
    wf_q = await db.execute(select(ApprovalWorkflow).where(ApprovalWorkflow.id == request.workflow_id))
    wf = wf_q.scalar_one_or_none()
    project_id = wf.project_id if wf else None
    
    starting_position_id = emp.position_id
    if user.active_role_id:
        active_pos_id = None
        if project_id:
            pos_q = await db.execute(
                select(Position.id).where(
                    Position.employee_id == emp.id,
                    Position.role_id == user.active_role_id,
                    Position.project_id == project_id
                )
            )
            active_pos_id = pos_q.scalars().first()
            
        if not active_pos_id:
            pos_q = await db.execute(
                select(Position.id).where(
                    Position.employee_id == emp.id,
                    Position.role_id == user.active_role_id
                )
            )
            active_pos_id = pos_q.scalars().first()

        if active_pos_id:
            starting_position_id = active_pos_id
            
    ancestors = await get_position_ancestors(db, starting_position_id)
    chain_positions = []
    for pos in ancestors:
        if not pos.role_id:
            continue
        cfg_q = await db.execute(
            select(ProjectWorkflowConfig).where(
                ProjectWorkflowConfig.project_id == project_id,
                ProjectWorkflowConfig.role_id == pos.role_id
            )
        )
        cfg = cfg_q.scalar_one_or_none()
        if cfg:
            if request.document_type == "indent" and cfg.indent_approve:
                chain_positions.append(pos)
            elif request.document_type == "dispatch" and cfg.dispatch_approve:
                chain_positions.append(pos)

    # View-only configuration grants permission to view the document, but is not treated as a workflow step/level.
                
    if 0 <= (level_num - 1) < len(chain_positions):
        return chain_positions[level_num - 1]
    return None


async def active_delegations_for(
    db: AsyncSession,
    delegatee_id: int,
    module: Optional[str] = None,
) -> List[ApprovalDelegation]:
    """Returns currently-active delegations *to* this user. A delegation is
    active when it is `is_active=true`, the current time is between
    valid_from / valid_to, and (if `module` is provided) the delegation's
    scope_module is null OR matches.
    """
    now = datetime.now(timezone.utc)
    # BUG-APR-028 — valid_to is treated as an exclusive upper bound. With
    # `>=` two delegations with exactly contiguous windows
    # (A:2026-01-01..2026-02-01, B:2026-02-01..2026-03-01) would both match
    # at the boundary second and `delegated_user_ids_for` would return both
    # delegators, so an approver gets routing they shouldn't see for that
    # transitional second.
    conditions = [
        ApprovalDelegation.delegatee_id == delegatee_id,
        ApprovalDelegation.is_active == True,  # noqa: E712
        ApprovalDelegation.valid_from <= now,
        ApprovalDelegation.valid_to > now,
    ]
    if module:
        conditions.append(
            or_(
                ApprovalDelegation.scope_module.is_(None),
                ApprovalDelegation.scope_module == module,
            )
        )
    result = await db.execute(
        select(ApprovalDelegation).where(and_(*conditions))
    )
    return list(result.scalars().all())


async def delegated_user_ids_for(
    db: AsyncSession,
    delegatee_id: int,
    module: Optional[str] = None,
) -> Set[int]:
    """Returns the set of user-ids whose approvals the given user is currently
    eligible to act on by virtue of an active delegation."""
    rows = await active_delegations_for(db, delegatee_id, module)
    return {r.delegator_id for r in rows}


async def find_workflow(
    db: AsyncSession,
    module: str,
    document_type: str,
    project_id: Optional[int] = None,
) -> Optional[ApprovalWorkflow]:
    """Find the active approval workflow for a module/document type.

    BUG-APR-015 — multiple matching active workflows used to be resolved
    by the database's natural row order (LIMIT 1 with no ORDER BY), so
    which workflow you actually got was non-deterministic. Order by id
    desc so the most recently-created active workflow wins predictably.

    BUG-APR-014 — when a project-scoped workflow exists but is inactive,
    don't silently fall through to the org-wide (project_id NULL) one.
    The fallback only fires when *no* project-scoped row exists at all
    (active or inactive); a deactivated project workflow is an explicit
    "do not use this" signal and must be respected.
    """
    if project_id:
        # Check if any project-scoped row exists (active OR inactive). If
        # one does, only the active variant is acceptable; we never spill
        # over to the org-wide fallback. System Hierarchical Workflows (without levels) are excluded.
        any_project_row = await db.execute(
            select(ApprovalWorkflow.id).where(
                ApprovalWorkflow.module == module,
                ApprovalWorkflow.document_type == document_type,
                ApprovalWorkflow.project_id == project_id,
                ~ApprovalWorkflow.name.like("System Hierarchical Workflow%"),
            ).limit(1)
        )
        has_project_scoped = any_project_row.scalar_one_or_none() is not None
        if has_project_scoped:
            result = await db.execute(
                select(ApprovalWorkflow).where(
                    ApprovalWorkflow.module == module,
                    ApprovalWorkflow.document_type == document_type,
                    ApprovalWorkflow.project_id == project_id,
                    ApprovalWorkflow.is_active == True,
                    ~ApprovalWorkflow.name.like("System Hierarchical Workflow%"),
                ).order_by(ApprovalWorkflow.id.desc()).limit(1)
            )
            return result.scalar_one_or_none()

    # Org-wide fallback (or original lookup when no project_id supplied).
    result = await db.execute(
        select(ApprovalWorkflow).where(
            ApprovalWorkflow.module == module,
            ApprovalWorkflow.document_type == document_type,
            ApprovalWorkflow.is_active == True,
            ApprovalWorkflow.project_id.is_(None),
            ~ApprovalWorkflow.name.like("System Hierarchical Workflow%"),
        ).order_by(ApprovalWorkflow.id.desc()).limit(1)
    )
    return result.scalar_one_or_none()


def _level_matches_conditions(
    level: ApprovalLevel,
    *,
    amount: Optional[float] = None,
    department: Optional[str] = None,
    category: Optional[str] = None,
    request_type: Optional[str] = None,
    extra: Optional[dict] = None,
) -> bool:
    """Returns True if this level's filter constraints (all NULLable) all
    match the submission context. NULL on a constraint = "don't care".

    `extra` is a dict of arbitrary fields (e.g. project_code, vendor_id,
    site_state) that the level's `condition_json` rule can reference via
    its key set. Engine supports these JSON shapes:
        {"eq": {"field_name": "exact_value"}}
        {"in": {"field_name": ["v1", "v2"]}}
        {"range": {"field_name": [min, max]}}     // numeric inclusive
    """
    from decimal import Decimal as _D
    # Amount range
    if amount is not None:
        try:
            amt = _D(str(amount))
            if amt < _D(str(level.min_amount)) or amt > _D(str(level.max_amount)):
                return False
        except Exception:
            return False
    # Direct columns
    if level.department and (not department or level.department != department):
        return False
    if level.category and (not category or level.category != category):
        return False
    if level.request_type and (
        not request_type or level.request_type != request_type
    ):
        return False
    # JSON rules
    if level.condition_json:
        # BUG-APR-012 — refuse pathologically large condition_json blobs
        # before parsing. The column is TEXT so admins could (accidentally
        # or maliciously) paste a multi-MB document; parsing it on every
        # submit_for_approval call would dominate latency. 16KB is well
        # past anything legitimate (the largest in-the-wild rules are ~1KB).
        if len(level.condition_json) > 16384:
            import logging
            logging.getLogger(__name__).error(
                "approval_service: condition_json on level id=%s exceeds "
                "16KB (%d bytes) — level skipped from routing",
                getattr(level, "id", "?"), len(level.condition_json),
            )
            return False
        try:
            import json as _json
            rules = _json.loads(level.condition_json)
        except Exception:
            # BUG-APR-011 — invalid condition_json used to silently match
            # (return True), which meant a typo'd rule effectively
            # disabled the level filter and admins never noticed. Log
            # loudly and treat the level as "does not apply" so a
            # misconfiguration shows up immediately as missed routing
            # rather than as a stealth always-match.
            import logging
            logging.getLogger(__name__).error(
                "approval_service: invalid condition_json on level id=%s "
                "workflow_id=%s — level skipped from routing",
                getattr(level, "id", "?"), getattr(level, "workflow_id", "?"),
            )
            return False
        ctx = dict(extra or {})
        eq = rules.get("eq") or {}
        for field, expected in eq.items():
            if ctx.get(field) != expected:
                return False
        in_ = rules.get("in") or {}
        for field, allowed in in_.items():
            if ctx.get(field) not in allowed:
                return False
        rng = rules.get("range") or {}
        for field, (lo, hi) in rng.items():
            v = ctx.get(field)
            try:
                if v is None or v < lo or v > hi:
                    return False
            except Exception:
                return False
    return True


async def submit_for_approval(
    db: AsyncSession,
    module: str,
    document_type: str,
    document_id: int,
    document_number: str,
    requested_by: int,
    project_id: Optional[int] = None,
    amount: Optional[float] = None,
    *,
    department: Optional[str] = None,
    category: Optional[str] = None,
    request_type: Optional[str] = None,
    extra: Optional[dict] = None,
) -> Optional[ApprovalRequest]:
    """Submit a document for approval through the workflow engine.

    Wave 3: filters levels not just by amount but by department, category,
    request_type, and extensible JSON rules. New params are keyword-only
    so existing callers (which only pass module/doc/amount) keep working.
    """
    # Resolve project_id if not passed for indent/dispatch
    if not project_id and document_type in ("indent", "dispatch"):
        if document_type == "indent":
            from app.models.indent import Indent
            indent_res = await db.execute(select(Indent.project_id).where(Indent.id == document_id))
            project_id = indent_res.scalar_one_or_none()
        elif document_type == "dispatch":
            from app.models.dispatch import DispatchOrder
            from app.models.issue import MaterialIssue
            from app.models.indent import Indent
            
            # Try to resolve through material issue or first dispatch item
            disp_res = await db.execute(
                select(DispatchOrder.material_issue_id).where(DispatchOrder.id == document_id)
            )
            mi_id = disp_res.scalar_one_or_none()
            if mi_id:
                mi_res = await db.execute(
                    select(MaterialIssue.indent_id).where(MaterialIssue.id == mi_id)
                )
                ind_id = mi_res.scalar_one_or_none()
                if ind_id:
                    ind_res = await db.execute(select(Indent.project_id).where(Indent.id == ind_id))
                    project_id = ind_res.scalar_one_or_none()
            
            if not project_id:
                # Fallback: check first item
                from app.models.dispatch import DispatchOrderItem
                item_res = await db.execute(
                    select(DispatchOrderItem.indent_id)
                    .where(DispatchOrderItem.dispatch_order_id == document_id)
                    .limit(1)
                )
                ind_id = item_res.scalar_one_or_none()
                if ind_id:
                    ind_res = await db.execute(select(Indent.project_id).where(Indent.id == ind_id))
                    project_id = ind_res.scalar_one_or_none()

    # Hierarchical position reporting workflow for indents and dispatches
    if document_type in ("indent", "dispatch"):
        from app.models.user import User
        from app.models.settings_master import Employee
        
        # 1. Get starting position of the submitter
        user_q = await db.execute(select(User).where(User.id == requested_by))
        user = user_q.scalar_one_or_none()
        starting_position_id = None
        if user and user.employee_id:
            emp_q = await db.execute(select(Employee).where(Employee.id == user.employee_id))
            emp = emp_q.scalar_one_or_none()
            if emp:
                starting_position_id = emp.position_id
                if user.active_role_id:
                    from app.models.settings_master import Position
                    active_pos_id = None
                    if project_id:
                        pos_q = await db.execute(
                            select(Position.id).where(
                                Position.employee_id == emp.id,
                                Position.role_id == user.active_role_id,
                                Position.project_id == project_id
                            )
                        )
                        active_pos_id = pos_q.scalars().first()
                    
                    if not active_pos_id:
                        pos_q = await db.execute(
                            select(Position.id).where(
                                Position.employee_id == emp.id,
                                Position.role_id == user.active_role_id
                            )
                        )
                        active_pos_id = pos_q.scalars().first()

                    if active_pos_id:
                        starting_position_id = active_pos_id

        if starting_position_id:
            # 2. Get ancestors
            ancestors = await get_position_ancestors(db, starting_position_id)
            
            # 3. Filter ancestors by ProjectWorkflowConfig
            from app.models.approval import ProjectWorkflowConfig
            chain_positions = []
            for pos in ancestors:
                if not pos.role_id:
                    continue
                cfg_q = await db.execute(
                    select(ProjectWorkflowConfig).where(
                        ProjectWorkflowConfig.project_id == project_id,
                        ProjectWorkflowConfig.role_id == pos.role_id
                    )
                )
                cfg = cfg_q.scalar_one_or_none()
                if cfg:
                    if document_type == "indent" and cfg.indent_approve:
                        chain_positions.append(pos)
                    elif document_type == "dispatch" and cfg.dispatch_approve:
                        chain_positions.append(pos)

            # View-only configuration grants permission to view the document, but is not treated as a workflow step/level.
            
            # Find or create a system workflow for hierarchy routing
            workflow_res = await db.execute(
                select(ApprovalWorkflow).where(
                    ApprovalWorkflow.module == module,
                    ApprovalWorkflow.document_type == document_type,
                    ApprovalWorkflow.project_id == project_id,
                    ApprovalWorkflow.name.like("System Hierarchical Workflow%")
                ).limit(1)
            )
            workflow = workflow_res.scalar_one_or_none()
            if not workflow:
                workflow = ApprovalWorkflow(
                    name=f"System Hierarchical Workflow ({document_type.capitalize()})",
                    module=module,
                    document_type=document_type,
                    project_id=project_id,
                    is_active=True
                )
                db.add(workflow)
                await db.flush()

            # Save the request in ApprovalRequest
            total_levels = len(chain_positions)
            
            # If chain is empty, it means no approval is required, auto-approve it!
            status = "approved" if total_levels == 0 else "pending"
            completed_at = datetime.now(timezone.utc) if total_levels == 0 else None
            
            import json as _json
            extra_blob = None
            try:
                extra_blob = _json.dumps(extra) if extra else None
            except Exception:
                extra_blob = None

            request = ApprovalRequest(
                workflow_id=workflow.id,
                document_type=document_type,
                document_id=document_id,
                document_number=document_number,
                current_level=1,
                total_levels=total_levels if total_levels > 0 else 1,  # at least 1 level
                status=status,
                requested_by=requested_by,
                completed_at=completed_at,
                amount=amount,
                department=department,
                category=category,
                request_type=request_type,
                extra_json=extra_blob,
            )
            db.add(request)
            await db.flush()
            if total_levels == 0:
                await update_document_status(
                    db,
                    document_type=document_type,
                    document_id=document_id,
                    status="approved",
                    user_id=requested_by,
                    request=request
                )
            await send_approval_request_notifications(db, request)
            return request

    workflow = await find_workflow(db, module, document_type, project_id)
    if not workflow:
        return None

    result = await db.execute(
        select(ApprovalLevel)
        .where(ApprovalLevel.workflow_id == workflow.id)
        .order_by(ApprovalLevel.level)
    )
    levels = list(result.scalars().all())
    if not levels:
        return None

    applicable_levels = [
        l for l in levels
        if _level_matches_conditions(
            l,
            amount=amount,
            department=department,
            category=category,
            request_type=request_type,
            extra=extra,
        )
    ]

    if not applicable_levels:
        # Backwards-compat: if no level matches the filters, fall back to
        # any "unconstrained" level (no department/category/request_type/json).
        applicable_levels = [
            l for l in levels
            if not l.department and not l.category and not l.request_type
            and not l.condition_json
        ]
    if not applicable_levels:
        # BUG-APR-016 — the legacy last-ditch "take all levels" fallback
        # silently routed amount-/dept-/category-constrained workflows to
        # every level when nothing matched, completely bypassing Wave-3
        # routing intent. Only fall back when EVERY level is fully
        # unconstrained on the structured fields too — i.e., a pre-Wave-3
        # workflow that genuinely has no filters set anywhere. Otherwise
        # we refuse to invent a routing and let the caller surface "no
        # applicable workflow level".
        unconstrained_everywhere = all(
            (l.min_amount in (None, 0) or float(l.min_amount) == 0)
            and (
                l.max_amount is None
                or float(l.max_amount) >= 999999999
            )
            and not l.department
            and not l.category
            and not l.request_type
            and not l.condition_json
            for l in levels
        )
        if unconstrained_everywhere:
            applicable_levels = levels
        else:
            import logging
            logging.getLogger(__name__).warning(
                "approval_service: no level matched filters for workflow_id=%s "
                "(amount=%s, department=%s, category=%s, request_type=%s) — "
                "refusing to fall back to all-levels routing",
                getattr(workflow, "id", "?"),
                amount, department, category, request_type,
            )
            return None

    # Bug fix BUG_0004: current_level was hardcoded to 1, but levels are
    # numbered 1..N from the config. If only L2 applies (e.g. conditional
    # routing filtered L1 out for this amount/department), the request was
    # still trying to start at "level 1" which is L1 — making it look like
    # the request was stuck at a level it shouldn't be at, OR (when L1 was
    # auto-approved/empty) appearing to skip directly to L2.
    #
    # Now we explicitly start at the smallest applicable level NUMBER.
    applicable_levels.sort(key=lambda l: l.level)
    starting_level = applicable_levels[0].level
    # BUG-APR-007 — `total_levels` previously stored the *highest* level
    # number (e.g. 3 even when only L1 and L3 were applicable), making the
    # "current_level >= total_levels" terminator skip L3 when current was 1.
    # Use the count of applicable levels so the engine terminates after
    # the right number of approvals. The numeric `level` column on each
    # level is still authoritative for routing.
    total_levels = len(applicable_levels)

    # BUG-APR-009 fix (Wave 5): persist the routing context on the request
    # so re-evaluation (BUG-APR-008 _next_applicable_level) can run without
    # re-fetching the source document. extra_json keeps Wave-3 conditional-
    # routing inputs that don't have a dedicated column.
    import json as _json
    extra_blob = None
    try:
        extra_blob = _json.dumps(extra) if extra else None
    except Exception:
        extra_blob = None

    request = ApprovalRequest(
        workflow_id=workflow.id,
        document_type=document_type,
        document_id=document_id,
        document_number=document_number,
        current_level=starting_level,
        total_levels=total_levels,
        status="pending",
        requested_by=requested_by,
        amount=amount,
        department=department,
        category=category,
        request_type=request_type,
        extra_json=extra_blob,
    )
    db.add(request)
    await db.flush()
    await send_approval_request_notifications(db, request)
    return request


async def get_level_eligible_approver_ids(
    db: AsyncSession,
    workflow_id: int,
    level_num: int,
) -> Set[int]:
    """Returns the set of user-ids that are eligible to approve a given
    level. Includes the explicit user (if any) plus every user that holds
    the level's role.

    Used by the parallel-approver gate in `process_approval_action` to
    decide when "everyone has voted approve."
    """
    req_q = await db.execute(
        select(ApprovalRequest).where(
            ApprovalRequest.workflow_id == workflow_id,
            ApprovalRequest.status.in_(["pending", "on_hold"])
        ).limit(1)
    )
    request = req_q.scalar_one_or_none()
    
    is_hierarchical = False
    if request and request.document_type in ("indent", "dispatch"):
        active_pos = await get_hierarchical_active_position(db, request, level_num)
        if active_pos:
            is_hierarchical = True
            
            from app.models.user import User
            from app.models.settings_master import Employee
            
            eligible_users_q = await db.execute(
                select(User.id).join(Employee, Employee.id == User.employee_id).where(
                    or_(
                        Employee.position_id == active_pos.id,
                        User.employee_id == active_pos.employee_id
                    )
                )
            )
            return {r[0] for r in eligible_users_q.all()}

    result = await db.execute(
        select(ApprovalLevel).where(
            ApprovalLevel.workflow_id == workflow_id,
            ApprovalLevel.level == level_num,
        )
    )
    level = result.scalar_one_or_none()
    if not level:
        return set()
    eligible: Set[int] = set()
    if level.approver_user_id:
        eligible.add(level.approver_user_id)
    if level.approver_role_id:
        result = await db.execute(
            select(UserRole.user_id).where(UserRole.role_id == level.approver_role_id)
        )
        for r in result.all():
            eligible.add(r[0])
    return eligible


async def _next_applicable_level(db: AsyncSession, request) -> Optional[int]:
    """Find the next applicable level number after the current one.

    Wave 11.1 fix: previously approval just did `current_level += 1` — but if
    the workflow has gaps (e.g. only L1 and L3 are configured) or if Wave 3
    conditional routing means certain levels don't apply for this request,
    the +1 logic would route to a non-existent or non-applicable level.
    """
    is_hierarchical = False
    if request.document_type in ("indent", "dispatch"):
        active_pos = await get_hierarchical_active_position(db, request, request.current_level)
        if active_pos:
            is_hierarchical = True
            
    if is_hierarchical:
        if request.current_level < request.total_levels:
            return request.current_level + 1
        return None

    rows = await db.execute(
        select(ApprovalLevel.level)
        .where(
            ApprovalLevel.workflow_id == request.workflow_id,
            ApprovalLevel.level > request.current_level,
        )
        .order_by(ApprovalLevel.level.asc())
    )
    next_levels = [r[0] for r in rows.all()]
    return next_levels[0] if next_levels else None


async def process_approval_action(
    db: AsyncSession,
    request_id: int,
    action: str,
    action_by: int,
    comments: Optional[str] = None,
) -> ApprovalRequest:
    """Process an approval action (approve/reject/hold) on a request.

    Wave 4: when the current level has `requires_all=True`, an `approved`
    action only advances the level once *every* eligible approver has
    voted approve. A single `rejected` still terminates the whole request.

    BUG-APR-001: lock the request row before mutating to prevent two
    concurrent approve/reject calls from both succeeding (double-approval
    race).

    BUG-APR-002: re-verify the request is still `pending` after taking
    the lock — the prior caller may have just rejected/approved/held it.
    """
    from fastapi import HTTPException
    result = await db.execute(
        select(ApprovalRequest)
        .where(ApprovalRequest.id == request_id)
        .with_for_update()
    )
    request = result.scalar_one_or_none()
    if request is None:
        raise HTTPException(status_code=404, detail="Approval request not found")
    if request.status not in ("pending", "on_hold"):
        raise HTTPException(
            status_code=409,
            detail=(
                f"Approval request is not in pending or on_hold status "
                f"(current status: {request.status})"
            ),
        )

    history_action = action
    history_comments = comments
    if action == "unhold":
        history_action = "returned"
        history_comments = f"[Unhold] {comments}" if comments else "Document unheld"

    # Always record the history row (audit).
    history = ApprovalHistory(
        request_id=request_id,
        level=request.current_level,
        action=history_action,
        action_by=action_by,
        comments=history_comments,
    )
    db.add(history)

    # Look up the current level config once.
    result = await db.execute(
        select(ApprovalLevel).where(
            ApprovalLevel.workflow_id == request.workflow_id,
            ApprovalLevel.level == request.current_level,
        )
    )
    level = result.scalar_one_or_none()

    if action == "approved":
        if level and level.requires_all:
            # Have all eligible approvers voted approve at this level?
            eligible = await get_level_eligible_approver_ids(
                db, request.workflow_id, request.current_level
            )
            await db.flush()
            voted = await db.execute(
                select(ApprovalHistory.action_by).where(
                    ApprovalHistory.request_id == request_id,
                    ApprovalHistory.level == request.current_level,
                    ApprovalHistory.action == "approved",
                )
            )
            voted_set = {r[0] for r in voted.all()}
            if eligible and eligible.issubset(voted_set):
                # Everyone approved → advance to next applicable level.
                next_lvl = await _next_applicable_level(db, request)
                if next_lvl is None or request.current_level >= request.total_levels:
                    request.status = "approved"
                    request.completed_at = datetime.now(timezone.utc)
                    await send_approval_request_notifications(db, request)
                else:
                    request.current_level = next_lvl
                    await send_approval_request_notifications(db, request)
            # else: still pending at this level, waiting for other voters
        else:
            # Legacy single-approver behavior — advance to next applicable level.
            next_lvl = await _next_applicable_level(db, request)
            if next_lvl is None or request.current_level >= request.total_levels:
                request.status = "approved"
                request.completed_at = datetime.now(timezone.utc)
                await send_approval_request_notifications(db, request)
            else:
                request.current_level = next_lvl
                await send_approval_request_notifications(db, request)
    elif action == "rejected":
        request.status = "rejected"
        request.completed_at = datetime.now(timezone.utc)
    elif action == "on_hold":
        request.status = "on_hold"
    elif action == "unhold":
        request.status = "pending"
    elif action == "returned":
        is_hierarchical = False
        if request.document_type in ("indent", "dispatch"):
            active_pos = await get_hierarchical_active_position(db, request, request.current_level)
            if active_pos:
                is_hierarchical = True

        if is_hierarchical:
            if request.current_level > 1:
                request.current_level -= 1
            request.status = "pending"
        else:
            # BUG-APR-003 — a naive `current_level -= 1` doesn't account for
            # workflows with non-contiguous applicable levels (e.g. only L1
            # and L3 apply for this request — returning from L3 should land
            # at L1, not at L2 which never applied). Walk the level table
            # backwards looking for the largest applicable level strictly
            # less than the current one.
            prev_levels_rows = await db.execute(
                select(ApprovalLevel.level)
                .where(
                    ApprovalLevel.workflow_id == request.workflow_id,
                    ApprovalLevel.level < request.current_level,
                )
                .order_by(ApprovalLevel.level.desc())
            )
            prev_levels = [r[0] for r in prev_levels_rows.all()]
            if prev_levels:
                request.current_level = prev_levels[0]
            request.status = "pending"

        # BUG-APR-023 — notify the user(s) the request was returned to
        # so they don't have to discover it by polling the queue.
        try:
            from app.services.notification_service import create_bulk_notifications
            recipients = await get_level_eligible_approver_ids(
                db, request.workflow_id, request.current_level
            )
            if recipients:
                await create_bulk_notifications(
                    db,
                    user_ids=list(recipients),
                    title="Approval returned to you",
                    message=(
                        f"Request {request.document_number or request.id} "
                        f"was returned to level {request.current_level}."
                        + (f" Reason: {comments}" if comments else "")
                    ),
                    notification_type="approval",
                    module=None,
                    reference_type="approval_request",
                    reference_id=request.id,
                )
        except Exception:
            pass

    await db.flush()
    if request.status in ("approved", "rejected", "on_hold", "pending"):
        await update_document_status(
            db,
            document_type=request.document_type,
            document_id=request.document_id,
            status=request.status,
            user_id=action_by,
            request=request
        )
        await db.flush()
    return request


async def can_user_approve(
    db: AsyncSession,
    request_id: int,
    user_id: int,
) -> bool:
    """Check if a user can approve the current level of an approval request.

    Honors:
      - Direct user assignment (approver_user_id)
      - Role membership (approver_role_id)
      - Active approval delegations (delegator → delegatee)
      - SLA escalation target (request.escalated_to_user_id)
    """
    result = await db.execute(
        select(ApprovalRequest).where(ApprovalRequest.id == request_id)
    )
    request = result.scalar_one_or_none()
    if not request or request.status not in ("pending", "on_hold"):
        return False

    # BUG-APR-024 / BUG-IND-006 — separation of duties. The requester can
    # never approve their own request (even if they hold the level's role).
    # Admin/super_admin overrides happen upstream in process_action.
    if request.requested_by == user_id:
        return False

    # Check if this is a hierarchical document type (indent or dispatch)
    if request.document_type in ("indent", "dispatch"):
        active_pos = await get_hierarchical_active_position(db, request, request.current_level)
        if active_pos:
            # Resolve delegations once for this user/module combo.
            workflow = await db.execute(
                select(ApprovalWorkflow).where(ApprovalWorkflow.id == request.workflow_id)
            )
            workflow = workflow.scalar_one_or_none()
            module = workflow.module if workflow else None
            delegated_from: Set[int] = await delegated_user_ids_for(db, user_id, module)

            from app.models.user import User
            from app.models.settings_master import Employee

            # Retrieve user IDs associated with active_pos
            eligible_users_q = await db.execute(
                select(User.id).join(Employee, Employee.id == User.employee_id).where(
                    or_(
                        Employee.position_id == active_pos.id,
                        User.employee_id == active_pos.employee_id
                    )
                )
            )
            eligible_user_ids = {r[0] for r in eligible_users_q.all()}

            # Get user's active role and position
            user_q = await db.execute(select(User).where(User.id == user_id))
            user_obj = user_q.scalar_one_or_none()
            user_role_id = user_obj.active_role_id if user_obj else None
            
            user_pos_id = None
            if user_obj and user_obj.employee_id:
                emp_q = await db.execute(select(Employee).where(Employee.id == user_obj.employee_id))
                user_emp = emp_q.scalar_one_or_none()
                user_pos_id = user_emp.position_id if user_emp else None

            is_user_eligible = (user_id in eligible_user_ids)
            pos_role_id = getattr(active_pos, 'role_id', None)

            # 1. Direct active position match
            if is_user_eligible and user_pos_id == active_pos.id:
                return True

            # 2. Active role match (must also be eligible for this position)
            if is_user_eligible and user_role_id and pos_role_id and user_role_id == pos_role_id:
                return True

            # 3. Delegations
            if delegated_from & eligible_user_ids:
                return True

            return False
        else:
            # Fallback: position chain is broken or not configured for this
            # document. Fall back to checking if the user's role has
            # indent_approve / dispatch_approve permission via
            # ProjectWorkflowConfig. Without this, hierarchical requests
            # with a broken chain are invisible in everyone's queue.
            try:
                from app.models.settings_master import Employee, Position
                from app.models.approval import ProjectWorkflowConfig

                # Get the project from the workflow
                wf_q = await db.execute(
                    select(ApprovalWorkflow).where(ApprovalWorkflow.id == request.workflow_id)
                )
                wf = wf_q.scalar_one_or_none()
                project_id = wf.project_id if wf else None

                # Get the user's current role
                user_q = await db.execute(select(User).where(User.id == user_id))
                user_obj = user_q.scalar_one_or_none()
                user_role_id = user_obj.active_role_id if user_obj else None

                if user_role_id and project_id:
                    approve_field = (
                        ProjectWorkflowConfig.indent_approve
                        if request.document_type == "indent"
                        else ProjectWorkflowConfig.dispatch_approve
                    )
                    cfg_q = await db.execute(
                        select(ProjectWorkflowConfig).where(
                            ProjectWorkflowConfig.project_id == project_id,
                            ProjectWorkflowConfig.role_id == user_role_id,
                            approve_field == True,
                        )
                    )
                    if cfg_q.scalar_one_or_none():
                        return True
            except Exception:
                pass
            return False

    # Get the current level definition
    result = await db.execute(
        select(ApprovalLevel).where(
            ApprovalLevel.workflow_id == request.workflow_id,
            ApprovalLevel.level == request.current_level,
        )
    )
    level = result.scalar_one_or_none()

    # Wave 4 — for parallel-approver levels, refuse a user who has already
    # voted approve at the current level (no double-counting).
    # BUG-APR-025 — must also apply to escalation targets. The original
    # short-circuit returned True for an escalation target before the
    # requires_all dedupe ran, so the same user could vote twice on a
    # parallel-approver level if they got escalated to.
    if level and level.requires_all:
        already = await db.execute(
            select(ApprovalHistory.id).where(
                ApprovalHistory.request_id == request_id,
                ApprovalHistory.level == request.current_level,
                ApprovalHistory.action_by == user_id,
                ApprovalHistory.action == "approved",
            )
        )
        if already.scalar_one_or_none():
            return False

    # Escalation target: short-circuit allow (after the dedupe gate above).
    if request.escalated_to_user_id and request.escalated_to_user_id == user_id:
        return True

    if not level:
        return False

    # Resolve delegations once for this user/module combo. The workflow's
    # `module` field gives us the scope to match against.
    workflow = await db.execute(
        select(ApprovalWorkflow).where(ApprovalWorkflow.id == request.workflow_id)
    )
    workflow = workflow.scalar_one_or_none()
    module = workflow.module if workflow else None
    delegated_from: Set[int] = await delegated_user_ids_for(db, user_id, module)

    # Direct user assignment OR delegated-from match
    if level.approver_user_id:
        if level.approver_user_id == user_id:
            return True
        if level.approver_user_id in delegated_from:
            return True

    # Role match: user has the role directly OR a delegator does
    if level.approver_role_id:
        result = await db.execute(
            select(UserRole).where(
                UserRole.user_id == user_id,
                UserRole.role_id == level.approver_role_id,
            )
        )
        if result.scalar_one_or_none():
            return True
        # Delegated role match
        if delegated_from:
            result = await db.execute(
                select(UserRole).where(
                    UserRole.user_id.in_(delegated_from),
                    UserRole.role_id == level.approver_role_id,
                )
            )
            if result.scalar_one_or_none():
                return True

    return False


async def get_pending_approvals(
    db: AsyncSession,
    user_id: int,
    include_on_hold: bool = False,
) -> list:
    """Get all pending approval requests that the user can act on.

    Super Admin always sees every pending approval regardless of per-workflow
    level configuration — they're the escape hatch when an approver is
    unavailable and the matrix is misconfigured.

    Identity check is by role **code** ("super_admin"), not by magic id 1, so
    a role re-seed on UAT vs prod cannot silently elevate or demote anyone.
    """
    from sqlalchemy import or_

    result = await db.execute(
        select(UserRole.role_id, Role.code)
        .join(Role, Role.id == UserRole.role_id)
        .where(UserRole.user_id == user_id)
    )
    rows = result.all()
    role_ids = [r[0] for r in rows]
    role_codes = {r[1] for r in rows}

    # 2026-05-05: include on_hold requests when the caller asks. Without
    # this, an approver who clicks Hold loses the request entirely — it
    # vanishes from their inbox and there's no way to resume it.
    statuses = ["pending", "on_hold"] if include_on_hold else ["pending"]
    base_query = (
        select(ApprovalRequest)
        .where(ApprovalRequest.status.in_(statuses))
        .order_by(ApprovalRequest.requested_at.desc())
    )

    # BUG-APR-006 — bypass divergence fix. process_action grants both
    # super_admin and admin; this function previously only honored
    # super_admin, so admins saw an empty pending queue but could still
    # act on individual requests they got direct links to. Include both.
    if {"super_admin", "admin"} & role_codes:
        result = await db.execute(base_query)
        return result.scalars().all()

    # Everyone else: join the current approval level and match by
    # explicit user assignment, role membership, OR active delegation.
    delegated_from = await delegated_user_ids_for(db, user_id)

    # Roles that the delegators have (so we widen by their role IDs too).
    delegated_role_ids: list = []
    if delegated_from:
        result = await db.execute(
            select(UserRole.role_id).where(UserRole.user_id.in_(delegated_from))
        )
        delegated_role_ids = [r[0] for r in result.all()]

    conditions = [ApprovalLevel.approver_user_id == user_id]
    if delegated_from:
        conditions.append(ApprovalLevel.approver_user_id.in_(delegated_from))
    role_id_set = set(role_ids) | set(delegated_role_ids)
    if role_id_set:
        conditions.append(ApprovalLevel.approver_role_id.in_(role_id_set))

    result = await db.execute(
        base_query.join(
            ApprovalLevel,
            and_(
                ApprovalLevel.workflow_id == ApprovalRequest.workflow_id,
                ApprovalLevel.level == ApprovalRequest.current_level,
            ),
        ).where(or_(*conditions))
    )
    role_results = list(result.scalars().all())

    # ALSO include requests that have been escalated TO this user. They
    # may not match the level's normal approver chain anymore.
    escalated_result = await db.execute(
        base_query.where(ApprovalRequest.escalated_to_user_id == user_id)
    )
    escalated_results = list(escalated_result.scalars().all())

    # ALSO query pending hierarchical requests (indent and dispatch)
    hierarchical_query = select(ApprovalRequest).where(
        ApprovalRequest.document_type.in_(["indent", "dispatch"]),
        ApprovalRequest.status.in_(statuses)
    )
    h_res = await db.execute(hierarchical_query)
    h_requests = h_res.scalars().all()
    
    # Filter them in Python using can_user_approve
    allowed_h_requests = []
    for req in h_requests:
        if await can_user_approve(db, req.id, user_id):
            allowed_h_requests.append(req)

    # Dedupe by id while preserving order.
    seen = set()
    out = []
    for r in role_results + escalated_results + allowed_h_requests:
        if r.id not in seen:
            seen.add(r.id)
            out.append(r)

    # 2026-05-06: separation of duties — never show a request to the user
    # who submitted it. can_user_approve already 403s on click, but without
    # this filter the request still rendered in their pending queue with an
    # active Approve tick that always failed. Only managerial roles
    # (super_admin/admin) can see their own — they can bypass via
    # process_action's is_admin path.
    from app.utils.dependencies import get_user_role_codes as _grc
    role_codes_for_user = await _grc(db, user_id)
    role_codes_set = set(role_codes_for_user) if role_codes_for_user else set()
    is_admin_caller = bool({"super_admin", "admin"} & role_codes_set)
    if not is_admin_caller:
        out = [r for r in out if r.requested_by != user_id]

    # 2026-05-06: warehouse scoping. Without this, two users sharing the same
    # role (e.g. field_supervisor on AP104 vs AP108) saw each other's
    # approval queue because routing was role-only. The approver should only
    # see requests whose source document is in a warehouse mapped to them.
    # Admin / super_admin already returned earlier, so this scoping only
    # applies to the operational roles below.
    if not out:
        return out

    from app.models.user import UserWarehouse
    wh_rows = await db.execute(
        select(UserWarehouse.warehouse_id).where(UserWarehouse.user_id == user_id)
    )
    user_wh_ids = {int(r[0]) for r in wh_rows.all()}
    # No warehouse mapping = treat as cross-warehouse approver (legacy
    # behavior); else filter strictly.
    if not user_wh_ids:
        return out

    # Group request ids by document_type to fetch warehouse_id efficiently.
    by_type: dict[str, list[int]] = {}
    for r in out:
        by_type.setdefault(r.document_type, []).append(r.document_id)

    # Map each (document_type, document_id) -> warehouse_id by querying the
    # source models. Documents without a warehouse_id (rare; some MRs may
    # be cross-warehouse) are kept — better to over-show than to hide.
    wh_map: dict[tuple[str, int], int | None] = {}
    try:
        from app.models.indent import Indent
        from app.models.procurement import MaterialRequest, PurchaseOrder
        from app.models.transfer import StockTransfer
        type_model_map = {
            "indent": Indent,
            "material_request": MaterialRequest,
            "purchase_order": PurchaseOrder,
            "stock_transfer": StockTransfer,
        }
        for dt, ids in by_type.items():
            mdl = type_model_map.get(dt)
            if not mdl or not hasattr(mdl, "warehouse_id"):
                continue
            rows = await db.execute(
                select(mdl.id, mdl.warehouse_id).where(mdl.id.in_(ids))
            )
            for rid, wid in rows.all():
                wh_map[(dt, int(rid))] = int(wid) if wid is not None else None
    except Exception:
        # If we can't fetch, fall back to unscoped (don't hide the queue).
        return out

    filtered = []
    for r in out:
        # Hierarchical approvals (indents and dispatches) are routed strictly based on
        # position hierarchy; do not filter them by warehouse assignments.
        if r.document_type in ("indent", "dispatch"):
            filtered.append(r)
            continue
        wid = wh_map.get((r.document_type, r.document_id))
        if wid is None or wid in user_wh_ids:
            filtered.append(r)
    return filtered


# ────────────────────────────────────────────────────────────────────────────
# SLA escalation processor (Wave 2 of the configurable workflow engine)
# ────────────────────────────────────────────────────────────────────────────

async def find_sla_breaches(
    db: AsyncSession,
    only_unescalated: bool = True,
):
    """Returns a list of (ApprovalRequest, ApprovalLevel, hours_overdue)
    tuples for requests whose current level has a non-zero SLA and whose
    requested_at + escalation_after_hours has passed.

    When only_unescalated is True (default), excludes requests already
    bumped — caller can re-scan safely without re-firing escalations.
    """
    from datetime import timedelta
    now = datetime.now(timezone.utc)

    base = (
        select(ApprovalRequest, ApprovalLevel)
        .join(
            ApprovalLevel,
            and_(
                ApprovalLevel.workflow_id == ApprovalRequest.workflow_id,
                ApprovalLevel.level == ApprovalRequest.current_level,
            ),
        )
        .where(ApprovalRequest.status == "pending")
        .where(ApprovalLevel.escalation_after_hours > 0)
    )
    if only_unescalated:
        base = base.where(ApprovalRequest.escalated_to_user_id.is_(None))

    result = await db.execute(base)
    out = []
    for req, lvl in result.all():
        if not req.requested_at or not lvl.escalation_after_hours:
            continue
        # MySQL DATETIME columns come back tz-naive; normalize to UTC so we
        # don't blow up comparing against `now` (which is tz-aware).
        # BUG-APR-027 — once a request has been escalated, the breach
        # clock for the *next* breach should start from `escalated_at`,
        # not from the original `requested_at`. Otherwise an already-
        # escalated request is permanently "more overdue" than its
        # configured SLA and re-escalates instantly on every scan.
        ref_at = req.escalated_at or req.requested_at
        if ref_at.tzinfo is None:
            ref_at = ref_at.replace(tzinfo=timezone.utc)
        deadline = ref_at + timedelta(hours=lvl.escalation_after_hours)
        if now >= deadline:
            overdue_hours = (now - deadline).total_seconds() / 3600.0
            out.append((req, lvl, overdue_hours))
    return out


async def process_escalations(
    db: AsyncSession,
    actor_id: int,
    dry_run: bool = False,
) -> dict:
    """Scans every pending approval request and, for any whose current
    level has breached its SLA window AND has an escalation_user_id
    configured, stamps the request with the escalation target + records a
    history row. Returns a summary of {scanned, escalated, skipped}.

    `actor_id` is the user-id that gets recorded on the history row (use
    the cron user, or whoever called the endpoint).
    """
    breaches = await find_sla_breaches(db, only_unescalated=True)

    escalated = 0
    skipped_no_target = 0
    skipped_already_handled = 0
    for req, lvl, overdue in breaches:
        if not lvl.escalation_user_id:
            skipped_no_target += 1
            continue
        if dry_run:
            escalated += 1
            continue
        # BUG-APR-005 — take a row lock + re-verify state before mutating.
        # The previous loop iterated detached read-time copies and could
        # double-escalate the same request when two cron workers raced, or
        # escalate a request that another approver had just approved /
        # rejected mid-scan. Re-fetching with `with_for_update` serializes
        # the mutation and the post-lock state check skips anything that
        # changed since `find_sla_breaches` ran.
        locked_row = await db.execute(
            select(ApprovalRequest)
            .where(ApprovalRequest.id == req.id)
            .with_for_update()
        )
        locked_req = locked_row.scalar_one_or_none()
        if (
            locked_req is None
            or locked_req.status != "pending"
            or locked_req.escalated_to_user_id is not None
        ):
            skipped_already_handled += 1
            continue
        # Re-bind `req` to the locked row so the mutations below land on
        # the freshly-fetched, locked instance.
        req = locked_req
        # BUG-APR-026 — if the configured escalation target has set up an
        # *outgoing* delegation (i.e., they themselves are unavailable and
        # have delegated their incoming approvals), reroute the
        # escalation to the delegatee. Without this, escalations land in
        # the inbox of someone who explicitly said they're not available.
        target_user_id = lvl.escalation_user_id
        try:
            workflow_row = await db.execute(
                select(ApprovalWorkflow.module).where(
                    ApprovalWorkflow.id == req.workflow_id
                )
            )
            module = workflow_row.scalar_one_or_none()
            now = datetime.now(timezone.utc)
            deleg_row = await db.execute(
                select(ApprovalDelegation)
                .where(
                    ApprovalDelegation.delegator_id == lvl.escalation_user_id,
                    ApprovalDelegation.is_active == True,  # noqa: E712
                    ApprovalDelegation.valid_from <= now,
                    # BUG-APR-028 — exclusive upper bound.
                    ApprovalDelegation.valid_to > now,
                )
                .order_by(ApprovalDelegation.created_at.desc())
                .limit(1)
            )
            d = deleg_row.scalar_one_or_none()
            if d and (d.scope_module is None or d.scope_module == module):
                target_user_id = d.delegatee_id
        except Exception:
            target_user_id = lvl.escalation_user_id
        req.escalated_to_user_id = target_user_id
        req.escalated_at = datetime.now(timezone.utc)
        req.escalation_count = (req.escalation_count or 0) + 1
        history = ApprovalHistory(
            request_id=req.id,
            level=req.current_level,
            action="escalated",
            action_by=actor_id,
            comments=(
                f"Auto-escalated to user {lvl.escalation_user_id} "
                f"after {lvl.escalation_after_hours}h SLA "
                f"({overdue:.1f}h overdue)"
            ),
        )
        db.add(history)
        escalated += 1

    if not dry_run and escalated > 0:
        await db.flush()

    return {
        "scanned": len(breaches),
        "escalated": escalated,
        "skipped_no_target": skipped_no_target,
        "skipped_already_handled": skipped_already_handled,
        "dry_run": dry_run,
    }


async def notify_view_only_ancestors(db: AsyncSession, request: ApprovalRequest):
    try:
        from app.models.user import User
        from app.models.settings_master import Employee, Position
        from app.models.approval import ProjectWorkflowConfig, ApprovalWorkflow
        from app.services.notification_service import create_notification

        # Get the starting position of the submitter
        user_q = await db.execute(select(User).where(User.id == request.requested_by))
        user = user_q.scalar_one_or_none()
        if not user or not user.employee_id:
            return
        
        emp_q = await db.execute(select(Employee).where(Employee.id == user.employee_id))
        emp = emp_q.scalar_one_or_none()
        if not emp or not emp.position_id:
            return

        # Get workflow project_id
        wf_q = await db.execute(select(ApprovalWorkflow).where(ApprovalWorkflow.id == request.workflow_id))
        wf = wf_q.scalar_one_or_none()
        project_id = wf.project_id if wf else None
        if not project_id:
            return

        # Get ancestors
        ancestors = await get_position_ancestors(db, emp.position_id)
        
        for pos in ancestors:
            if not pos.role_id:
                continue
            
            # Check project workflow config
            cfg_q = await db.execute(
                select(ProjectWorkflowConfig).where(
                    ProjectWorkflowConfig.project_id == project_id,
                    ProjectWorkflowConfig.role_id == pos.role_id
                )
            )
            cfg = cfg_q.scalar_one_or_none()
            if cfg:
                is_view_only = False
                if request.document_type == "indent" and cfg.indent_view and not cfg.indent_approve:
                    is_view_only = True
                elif request.document_type == "dispatch" and cfg.dispatch_view and not cfg.dispatch_approve:
                    is_view_only = True
                
                if is_view_only:
                    # Find users in this position or employee
                    eligible_users_q = await db.execute(
                        select(User.id).join(Employee, Employee.id == User.employee_id).where(
                            or_(
                                Employee.position_id == pos.id,
                                User.employee_id == pos.employee_id
                            )
                        )
                    )
                    user_ids = [r[0] for r in eligible_users_q.all()]
                    
                    # Create notification for each
                    for uid in user_ids:
                        await create_notification(
                            db=db,
                            user_id=uid,
                            title=f"{request.document_type.capitalize()} Approved (View-only)",
                            message=f"{request.document_type.capitalize()} {request.document_number} has been approved and is available for your review.",
                            notification_type="success",
                            module=request.document_type,
                            reference_type=request.document_type,
                            reference_id=request.document_id,
                        )
    except Exception as e:
        import logging
        logging.getLogger(__name__).exception("Failed to notify view-only ancestors: %s", e)


async def send_approval_request_notifications(db: AsyncSession, request: ApprovalRequest):
    try:
        if request.status == "approved":
            await notify_view_only_ancestors(db, request)
        elif request.status == "pending":
            # Notify active approvers at current level
            from app.services.notification_service import create_notification
            approvers = await get_level_eligible_approver_ids(db, request.workflow_id, request.current_level)
            for uid in approvers:
                await create_notification(
                    db=db,
                    user_id=uid,
                    title=f"{request.document_type.capitalize()} Approval Required",
                    message=f"{request.document_type.capitalize()} {request.document_number} requires your approval at level {request.current_level}.",
                    notification_type="approval",
                    module=request.document_type,
                    reference_type=request.document_type,
                    reference_id=request.document_id,
                )
    except Exception as e:
        import logging
        logging.getLogger(__name__).exception("Failed to send approval request notifications: %s", e)


async def update_document_status(db: AsyncSession, document_type: str, document_id: int, status: str, user_id: int, request=None):
    """Update the source document status after approval/rejection.

    BUG-APR-047 — for indents, an `approved` outcome must run the indent
    lifecycle (stock check → auto-MI for in-stock lines, auto-MR for short
    lines). Previously this just stamped status='approved' and walked away,
    so the workflow-driven approval path silently skipped fulfillment.
    """
    from datetime import datetime, timezone
    from fastapi import HTTPException
    
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
            if request is not None:
                from app.models.indent import Indent as _Indent
                indent_obj = (await db.execute(select(_Indent).where(_Indent.id == document_id))).scalar_one_or_none()
                if indent_obj:
                    request.document_number = indent_obj.indent_number
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
    if status == "on_hold" or status == "pending":
        target_status = "pending_approval"

    if document_type == "purchase_order" and status == "approved":
        from app.services.number_series import generate_number
        from app.models.procurement import PurchaseOrder
        from sqlalchemy import update
        if doc.parent_po_id:
            parent_po = (await db.execute(select(PurchaseOrder).where(PurchaseOrder.id == doc.parent_po_id))).scalar_one_or_none()
            if not parent_po:
                raise HTTPException(status_code=400, detail="Parent Purchase Order not found")
            approved_po_number = f"{parent_po.base_po_number}-V{doc.version_number or '1.0'}"
            doc.po_number = approved_po_number
            doc.base_po_number = parent_po.base_po_number
        else:
            approved_base = await generate_number(db, "procurement", "purchase_order", pad_length=7)
            approved_po_number = f"{approved_base}-V1.0"
            doc.po_number = approved_po_number
            doc.base_po_number = approved_base

        doc.is_current = True

        # Mark all other versions of this PO as not current
        await db.execute(
            update(PurchaseOrder)
            .where(PurchaseOrder.base_po_number == doc.base_po_number, PurchaseOrder.id != doc.id)
            .values(is_current=False)
        )

        if request is not None:
            request.document_number = approved_po_number
        await db.flush()

        if doc.mr_id:
            from app.services.procurement_service import handle_po_approval_qtys
            await handle_po_approval_qtys(db, doc.id)

    if document_type == "indent" and status == "approved":
        if doc.indent_number and "FA-IND" in doc.indent_number:
            from app.services.number_series import generate_number
            approved_number = await generate_number(db, "indent", "indent", pad_length=7)
            doc.indent_number = approved_number
            if request is not None:
                request.document_number = approved_number

    if document_type == "material_request" and status == "approved":
        if doc.mr_number and "FA-MR" in doc.mr_number:
            from app.services.number_series import generate_number
            approved_number = await generate_number(db, "procurement", "material_request", pad_length=7)
            doc.mr_number = approved_number
            if request is not None:
                request.document_number = approved_number

    doc.status = target_status
    if hasattr(doc, "approved_by") and status == "approved":
        doc.approved_by = user_id
    if hasattr(doc, "approved_date") and status == "approved":
        doc.approved_date = datetime.now(timezone.utc)

