"""Business Rules Engine API — Wave 5.

CRUD on rules + executions log + manual fire endpoint for testing.
"""
from datetime import datetime
import json
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from typing import Optional, Dict, Any
from sqlalchemy import select, func, desc
from sqlalchemy.ext.asyncio import AsyncSession
from app.database import get_db
from app.models.user import User
from app.models.rules import BusinessRule, BusinessRuleExecution
from app.services.rules_engine import evaluate_rules
from app.utils.dependencies import get_current_user, require_any_role
from app.utils.helpers import paginate_params, build_paginated_response


router = APIRouter()


# ─── Schemas ───────────────────────────────────────────────────────────────

class RuleCreate(BaseModel):
    name: str
    description: Optional[str] = None
    trigger_event: str
    condition_json: str  # raw JSON string (frontend stringifies)
    action_type: str  # 'notify' | 'create_indent' | 'update_status'
    action_config: str  # raw JSON string
    is_active: bool = True


class RuleUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    trigger_event: Optional[str] = None
    condition_json: Optional[str] = None
    action_type: Optional[str] = None
    action_config: Optional[str] = None
    is_active: Optional[bool] = None


class FireRequest(BaseModel):
    event_name: str
    context: Dict[str, Any] = {}


def _rule_to_dict(r: BusinessRule) -> dict:
    return {
        "id": r.id,
        "name": r.name,
        "description": r.description,
        "trigger_event": r.trigger_event,
        "condition_json": r.condition_json,
        "action_type": r.action_type,
        "action_config": r.action_config,
        "is_active": r.is_active,
        "organization_id": r.organization_id,
        "created_by": r.created_by,
        "created_at": r.created_at.isoformat() if r.created_at else None,
        "last_fired_at": r.last_fired_at.isoformat() if r.last_fired_at else None,
        "fire_count": r.fire_count or 0,
    }


# ─── Endpoints ─────────────────────────────────────────────────────────────

@router.get("/rules")
async def list_rules(
    trigger_event: Optional[str] = Query(None),
    is_active: Optional[bool] = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """List business rules.

    BUG-HC-106 fix: previously every authenticated user could read the raw
    `condition_json` and `action_config` payloads, which embed internal field
    names, role-id whitelists, and downstream entity IDs. Restrict the verbose
    payload to admin / compliance roles; everyone else gets a redacted
    summary so the rule list is still browsable.
    """
    from app.utils.dependencies import get_user_role_codes
    user_roles = set(await get_user_role_codes(db, current_user.id))
    privileged = bool(user_roles & {
        "super_admin", "admin", "compliance_officer", "compliance",
    })

    q = select(BusinessRule).order_by(BusinessRule.created_at.desc())
    if trigger_event:
        q = q.where(BusinessRule.trigger_event == trigger_event)
    if is_active is not None:
        q = q.where(BusinessRule.is_active == is_active)
    result = await db.execute(q)
    rules = list(result.scalars().all())

    def _redacted(r: BusinessRule) -> dict:
        d = _rule_to_dict(r)
        # Strip the JSON internals; non-privileged users see only metadata.
        d["condition_json"] = "[redacted — admin only]"
        d["action_config"] = "[redacted — admin only]"
        return d

    rows = [_rule_to_dict(r) if privileged else _redacted(r) for r in rules]
    return {"results": rows, "total": len(rows)}


@router.get("/rules/{rule_id}")
async def get_rule(
    rule_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    rule = (await db.execute(select(BusinessRule).where(BusinessRule.id == rule_id))).scalar_one_or_none()
    if not rule:
        raise HTTPException(status_code=404, detail="Rule not found")
    return _rule_to_dict(rule)


@router.post("/rules", status_code=201)
async def create_rule(
    payload: RuleCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_any_role("super_admin", "admin")),
):
    # Validate JSON shape
    for field in ("condition_json", "action_config"):
        try:
            json.loads(getattr(payload, field))
        except Exception as e:
            raise HTTPException(status_code=422, detail=f"{field} must be valid JSON: {e}")
    rule = BusinessRule(
        name=payload.name,
        description=payload.description,
        trigger_event=payload.trigger_event,
        condition_json=payload.condition_json,
        action_type=payload.action_type,
        action_config=payload.action_config,
        is_active=payload.is_active,
        created_by=current_user.id,
    )
    db.add(rule)
    await db.flush()
    return _rule_to_dict(rule)


@router.put("/rules/{rule_id}")
async def update_rule(
    rule_id: int,
    payload: RuleUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_any_role("super_admin", "admin")),
):
    rule = (await db.execute(select(BusinessRule).where(BusinessRule.id == rule_id))).scalar_one_or_none()
    if not rule:
        raise HTTPException(status_code=404, detail="Rule not found")
    data = payload.model_dump(exclude_unset=True)
    for field in ("condition_json", "action_config"):
        if field in data and data[field] is not None:
            try:
                json.loads(data[field])
            except Exception as e:
                raise HTTPException(status_code=422, detail=f"{field} must be valid JSON: {e}")

    # BUG-HC-105 fix: capture is_active flips and other privileged edits
    # to the compliance audit log so admins can later see who toggled or
    # rewrote a rule and when. Audit failures are swallowed.
    prior_is_active = rule.is_active
    prior_action_type = rule.action_type
    prior_trigger = rule.trigger_event

    for k, v in data.items():
        setattr(rule, k, v)
    await db.flush()

    try:
        from app.services.compliance_service import log_audit
        changes: dict = {}
        if "is_active" in data and data["is_active"] != prior_is_active:
            changes["is_active"] = {"from": prior_is_active, "to": data["is_active"]}
        if "action_type" in data and data["action_type"] != prior_action_type:
            changes["action_type"] = {"from": prior_action_type, "to": data["action_type"]}
        if "trigger_event" in data and data["trigger_event"] != prior_trigger:
            changes["trigger_event"] = {"from": prior_trigger, "to": data["trigger_event"]}
        if "condition_json" in data:
            changes["condition_json"] = "modified"
        if "action_config" in data:
            changes["action_config"] = "modified"
        if changes:
            await log_audit(
                db,
                event_type="business_rule_updated",
                severity="info",
                source_type="business_rule",
                source_id=rule.id,
                user_id=current_user.id,
                payload={"rule_name": rule.name, "changes": changes},
            )
    except Exception:
        pass

    return _rule_to_dict(rule)


@router.delete("/rules/{rule_id}")
async def delete_rule(
    rule_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_any_role("super_admin", "admin")),
):
    rule = (await db.execute(select(BusinessRule).where(BusinessRule.id == rule_id))).scalar_one_or_none()
    if not rule:
        raise HTTPException(status_code=404, detail="Rule not found")
    await db.delete(rule)
    await db.flush()
    return {"success": True}


@router.get("/rules/{rule_id}/executions")
async def list_executions(
    rule_id: int,
    limit: int = Query(50, le=200),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    result = await db.execute(
        select(BusinessRuleExecution)
        .where(BusinessRuleExecution.rule_id == rule_id)
        .order_by(desc(BusinessRuleExecution.fired_at))
        .limit(limit)
    )
    rows = list(result.scalars().all())
    return {
        "results": [
            {
                "id": r.id,
                "fired_at": r.fired_at.isoformat() if r.fired_at else None,
                "status": r.status,
                "trigger_context": r.trigger_context,
                "result": r.result,
                "error": r.error,
            }
            for r in rows
        ],
        "total": len(rows),
    }


class FireRequestExt(BaseModel):
    event_name: str
    context: Dict[str, Any] = {}
    dry_run: bool = True  # default to dry-run so test calls don't side-effect


@router.post("/rules/fire")
async def fire_event(
    payload: FireRequestExt,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_any_role("super_admin", "admin")),
):
    """Manually publish an event — useful for admins testing rules without
    waiting for the underlying entity transaction to fire it.

    BUG-HC-104 fix: this endpoint previously *always* invoked the real action
    handlers, which could create real indents / send real notifications when
    an admin was just sanity-testing a rule. Default to dry_run=True; only
    when the caller explicitly passes dry_run=False do we evaluate for real.
    In dry-run mode we evaluate the condition tree but skip the action call,
    returning the would-fire rule list.
    """
    if payload.dry_run:
        # Just enumerate the matching rules without executing the side-effect.
        from app.models.rules import BusinessRule as _BR
        from app.services.rules_engine import evaluate_condition as _eval_cond
        rows = (await db.execute(
            select(_BR).where(
                _BR.trigger_event == payload.event_name,
                _BR.is_active == True,  # noqa: E712
            )
        )).scalars().all()
        would_fire = []
        for r in rows:
            try:
                cond_holds = _eval_cond(r.condition_json, payload.context)
            except Exception:
                cond_holds = False
            if cond_holds:
                would_fire.append({
                    "rule_id": r.id, "name": r.name, "action_type": r.action_type,
                })
        return {
            "success": True,
            "dry_run": True,
            "would_fire": would_fire,
            "fired": 0,
            "message": "Dry-run only — pass dry_run=false to actually execute actions.",
        }
    summaries = await evaluate_rules(db, payload.event_name, payload.context)
    return {"success": True, "dry_run": False, "fired": len(summaries), "summaries": summaries}


@router.get("/rules/meta/events")
async def list_events(
    current_user: User = Depends(get_current_user),
):
    """Catalog of events the engine emits (for the admin UI dropdown)."""
    return {
        "events": [
            {
                "name": "stock.balance_changed",
                "description": "Fired after every stock ledger posting (GRN, issue, transfer, audit, consumption)",
                "context_keys": [
                    "item_id", "item_code", "item_name", "item_type",
                    "warehouse_id", "available_qty", "total_qty", "reserved_qty",
                    "stock_value", "valuation_rate", "reorder_level", "reorder_qty",
                    "min_stock_level", "transaction_type", "qty_in", "qty_out",
                    "batch_id", "uom_id", "reference_type", "reference_id",
                ],
            },
            # Future: more event hooks as we instrument other services
        ],
        "actions": [
            {"name": "notify", "config": {"user_id": "int", "title": "str", "body": "str (template)"}},
            {"name": "create_indent", "config": {
                "warehouse_id_field": "context key",
                "item_id_field": "context key",
                "qty_field": "context key",
                "request_type": "auto_reorder|urgent|regular",
                "remarks": "str (template)",
                "dedupe": "bool — skip if open indent exists",
            }},
            {"name": "update_status", "config": {
                "entity_type": "indent|material_request|purchase_order|stock_transfer",
                "entity_id_field": "context key",
                "field": "status",
                "value": "new value",
            }},
        ],
        "operators": [
            "eq", "ne", "in", "not_in",
            "lte", "lt", "gte", "gt",
            "lte_field", "gte_field", "eq_field",
            "and", "or", "not",
        ],
    }
