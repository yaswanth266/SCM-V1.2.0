from datetime import datetime, timezone
from typing import Optional, List, Set
from sqlalchemy import select, and_, or_
from sqlalchemy.ext.asyncio import AsyncSession
from app.models.approval import (
    ApprovalWorkflow, ApprovalLevel, ApprovalRequest, ApprovalHistory,
    ApprovalDelegation,
)
from app.models.user import UserRole, Role


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
        # over to the org-wide fallback.
        any_project_row = await db.execute(
            select(ApprovalWorkflow.id).where(
                ApprovalWorkflow.module == module,
                ApprovalWorkflow.document_type == document_type,
                ApprovalWorkflow.project_id == project_id,
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
    if request.status != "pending":
        raise HTTPException(
            status_code=409,
            detail=(
                f"Approval request is no longer pending "
                f"(current status: {request.status})"
            ),
        )

    # Always record the history row (audit).
    history = ApprovalHistory(
        request_id=request_id,
        level=request.current_level,
        action=action,
        action_by=action_by,
        comments=comments,
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
                else:
                    request.current_level = next_lvl
            # else: still pending at this level, waiting for other voters
        else:
            # Legacy single-approver behavior — advance to next applicable level.
            next_lvl = await _next_applicable_level(db, request)
            if next_lvl is None or request.current_level >= request.total_levels:
                request.status = "approved"
                request.completed_at = datetime.now(timezone.utc)
            else:
                request.current_level = next_lvl
    elif action == "rejected":
        request.status = "rejected"
        request.completed_at = datetime.now(timezone.utc)
    elif action == "on_hold":
        request.status = "on_hold"
    elif action == "returned":
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
    if not request or request.status != "pending":
        return False

    # BUG-APR-024 / BUG-IND-006 — separation of duties. The requester can
    # never approve their own request (even if they hold the level's role).
    # Admin/super_admin overrides happen upstream in process_action.
    if request.requested_by == user_id:
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

    # Dedupe by id while preserving order.
    seen = set()
    out = []
    for r in role_results + escalated_results:
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
