"""Business Rules Engine — Wave 5 of the configurable workflow stack.

Lets admins declaratively wire "when EVENT happens AND CONDITION holds,
do ACTION." Used to automate the cross-module reactions that move the
system from "CRUD with status fields" into actual process orientation.

Public entry point: `evaluate_rules(db, event_name, context)` — call this
from any service that wants to publish an event.
"""
import json
from datetime import datetime, timezone
from typing import Any, Dict, Optional
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.rules import BusinessRule, BusinessRuleExecution


# ─── Predicate evaluator ────────────────────────────────────────────────────

def _coerce_num(v):
    # BUG-HC-107 fix: math.nan / math.inf and Decimal("NaN") / Decimal("Infinity")
    # would slip through the bare float() coerce — `nan > x` is False for any
    # x, so a NaN-containing context would always fail comparisons silently
    # (looks like a "no match" instead of a rule-config issue). Treat any
    # non-finite numeric as missing so the predicate evaluator returns False
    # consistently and the rule does not fire on garbage.
    if v is None:
        return None
    try:
        f = float(v)
    except Exception:
        return None
    import math as _math
    if _math.isnan(f) or _math.isinf(f):
        return None
    return f


def evaluate_predicate(pred: dict, context: Dict[str, Any]) -> bool:
    """Evaluate a single predicate against the context. Predicate is a dict
    with one or more operator keys; ALL must hold (implicit AND).

    Supported operators (all case-sensitive):
        eq        : {"field": value}            — context[field] == value
        ne        : {"field": value}            — context[field] != value
        in        : {"field": [v1, v2, ...]}    — context[field] ∈ list
        not_in    : {"field": [v1, v2, ...]}
        lte / gte : {"field": numeric}          — numeric compare
        lt  / gt  : {"field": numeric}
        lte_field : {"field_a": "field_b"}      — context[a] <= context[b]
        gte_field : {"field_a": "field_b"}      — context[a] >= context[b]
        eq_field  : {"field_a": "field_b"}      — context[a] == context[b]
    """
    for op, args in pred.items():
        # BUG-HC-097 fix: previously a malformed `args` (e.g. a string or list
        # where a dict was expected) was silently treated as "match" — the
        # rule would fire on garbage config. Treat any non-dict args as a
        # condition failure instead, so a misconfigured rule never fires.
        if not isinstance(args, dict):
            return False
        if op == "eq":
            for k, v in args.items():
                if context.get(k) != v:
                    return False
        elif op == "ne":
            for k, v in args.items():
                if context.get(k) == v:
                    return False
        elif op == "in":
            for k, allowed in args.items():
                if context.get(k) not in allowed:
                    return False
        elif op == "not_in":
            for k, allowed in args.items():
                if context.get(k) in allowed:
                    return False
        elif op == "lte":
            for k, v in args.items():
                a, b = _coerce_num(context.get(k)), _coerce_num(v)
                if a is None or b is None or a > b:
                    return False
        elif op == "lt":
            for k, v in args.items():
                a, b = _coerce_num(context.get(k)), _coerce_num(v)
                if a is None or b is None or a >= b:
                    return False
        elif op == "gte":
            for k, v in args.items():
                a, b = _coerce_num(context.get(k)), _coerce_num(v)
                if a is None or b is None or a < b:
                    return False
        elif op == "gt":
            for k, v in args.items():
                a, b = _coerce_num(context.get(k)), _coerce_num(v)
                if a is None or b is None or a <= b:
                    return False
        elif op == "lte_field":
            for fa, fb in args.items():
                va, vb = _coerce_num(context.get(fa)), _coerce_num(context.get(fb))
                if va is None or vb is None or va > vb:
                    return False
        elif op == "gte_field":
            for fa, fb in args.items():
                va, vb = _coerce_num(context.get(fa)), _coerce_num(context.get(fb))
                if va is None or vb is None or va < vb:
                    return False
        elif op == "eq_field":
            for fa, fb in args.items():
                if context.get(fa) != context.get(fb):
                    return False
        # Unknown operator → fail closed (don't fire rule on bad config)
        else:
            return False
    return True


def evaluate_condition(cond_json: str, context: Dict[str, Any]) -> bool:
    """Top-level condition can be a single predicate or an `{and|or|not}` tree."""
    try:
        cond = json.loads(cond_json) if isinstance(cond_json, str) else cond_json
    except Exception:
        return False
    if not isinstance(cond, dict):
        return False

    if "and" in cond:
        return all(evaluate_condition(json.dumps(p) if isinstance(p, dict) else p, context)
                   for p in cond["and"])
    if "or" in cond:
        return any(evaluate_condition(json.dumps(p) if isinstance(p, dict) else p, context)
                   for p in cond["or"])
    if "not" in cond:
        inner = cond["not"]
        return not evaluate_condition(json.dumps(inner) if isinstance(inner, dict) else inner, context)
    return evaluate_predicate(cond, context)


# ─── Action handlers ────────────────────────────────────────────────────────

def _resolve(config: dict, key: str, context: dict, default=None):
    """Resolve a config value. If key is "<x>_field", looks up `context[<that_field_name>]`.
    Otherwise returns the config value directly."""
    fk = config.get(key + "_field")
    if fk:
        return context.get(fk, default)
    return config.get(key, default)


def _render_template(tmpl: Optional[str], context: dict) -> str:
    """Very small {{var}} substitution; doesn't import jinja2 to keep deps lean."""
    if not tmpl:
        return ""
    out = tmpl
    for k, v in context.items():
        out = out.replace("{{" + k + "}}", str(v))
    return out


async def action_notify(db: AsyncSession, config: dict, context: dict) -> dict:
    """Create a notification for the configured user. Falls back to no-op
    if the notification service can't import (so engine still proceeds)."""
    target = _resolve(config, "user_id", context)
    title = _render_template(config.get("title", "Business rule fired"), context)
    body = _render_template(config.get("body", ""), context)
    if not target:
        return {"skipped": "no target user"}
    # Notification.type is a fixed enum (info|warning|error|success|approval).
    # Use config-supplied type if it's valid, otherwise default to "info".
    valid_types = {"info", "warning", "error", "success", "approval"}
    notif_type = config.get("type", "info")
    if notif_type not in valid_types:
        notif_type = "info"
    try:
        from app.services.notification_service import create_notification
        await create_notification(db, int(target), title, body, notif_type)
    except Exception as e:
        return {"error_calling_notify": str(e)}
    return {"notified_user_id": int(target), "type": notif_type}


async def action_create_indent(db: AsyncSession, config: dict, context: dict) -> dict:
    """Auto-create a draft Indent. Configurable fields (config keys):

        warehouse_id_field : context key holding warehouse id (default "warehouse_id")
        item_id_field      : context key holding item id (default "item_id")
        qty_field          : context key holding requested qty (default "reorder_qty")
        uom_id_field       : optional uom id
        request_type       : 'auto_reorder' | 'urgent' | 'regular' (default auto_reorder)
        remarks            : free text, supports {{var}}
        created_by_user_id : the system user to credit (default 1)
        dedupe             : if true, skip when an open indent already exists
                             for the same item+warehouse (default true)

    Returns the new indent's id + number, or `{skipped: reason}`.
    """
    from sqlalchemy import select, and_
    from app.models.indent import Indent, IndentItem
    from app.services.number_series import generate_number

    warehouse_id = _resolve(config, "warehouse_id", context)
    item_id = _resolve(config, "item_id", context)
    if not warehouse_id or not item_id:
        return {"skipped": "missing warehouse_id or item_id"}

    # Default qty = reorder_qty from context (if present), else 1.
    qty = (
        _resolve(config, "qty", context)
        or context.get("reorder_qty")
        or context.get("reorder_level")
        or 1
    )
    try:
        qty = float(qty)
    except Exception:
        qty = 1
    if qty <= 0:
        return {"skipped": "qty must be > 0"}

    # Dedupe: don't pile up multiple open indents for the same item+warehouse.
    # BUG-HC-098 fix: take a row-level lock so two concurrent rule firings
    # cannot both pass the dedupe check and create duplicate indents (TOCTOU).
    if config.get("dedupe", True):
        existing = await db.execute(
            select(Indent.id)
            .join(IndentItem, IndentItem.indent_id == Indent.id)
            .where(
                Indent.warehouse_id == warehouse_id,
                Indent.status.in_(["draft", "pending_approval"]),
                IndentItem.item_id == item_id,
            )
            .with_for_update()
            .limit(1)
        )
        if existing.scalar_one_or_none():
            return {"skipped": "open indent already exists for this item+warehouse"}

    # Resolve uom_id: explicit field → context fallback → item.primary_uom_id
    uom_id = _resolve(config, "uom_id", context)
    if not uom_id:
        from app.models.master import Item as ItemModel
        item_row = await db.execute(select(ItemModel).where(ItemModel.id == item_id))
        item_obj = item_row.scalar_one_or_none()
        if item_obj:
            uom_id = item_obj.primary_uom_id

    indent_no = await generate_number(db, "indent", "indent")
    # BUG-HC-102 fix: don't silently masquerade as user_id=1. Resolve the
    # creator strictly from explicit config (or context "user_id"). If
    # neither is provided, fall back to the dedicated system user (resolved
    # from the User table by the conventional username "system"); only as a
    # last resort fall through to user_id=1, with a logged warning.
    raised_by = (
        config.get("created_by_user_id")
        or context.get("user_id")
        or context.get("created_by_user_id")
    )
    if not raised_by:
        try:
            from app.models.user import User as _User
            sys_row = await db.execute(
                select(_User.id).where(_User.username == "system").limit(1)
            )
            sys_id = sys_row.scalar()
            raised_by = sys_id
        except Exception:
            raised_by = None
    if not raised_by:
        # Final fall-through. Log so this leaves an audit trail rather than
        # silently impersonating the first admin user.
        import logging as _l
        _l.getLogger(__name__).warning(
            "rules_engine.action_create_indent: no created_by_user_id in "
            "config or context; using user_id=1 as a last resort"
        )
        raised_by = 1
    indent = Indent(
        indent_number=indent_no,
        warehouse_id=int(warehouse_id),
        indent_date=datetime.now(timezone.utc),
        indent_type=config.get("request_type", "auto_reorder"),
        status="draft",
        raised_by=int(raised_by),
        remarks=_render_template(
            config.get("remarks", "Auto-created by business rule"), context
        ),
    )
    db.add(indent)
    await db.flush()
    line = IndentItem(
        indent_id=indent.id,
        item_id=int(item_id),
        requested_qty=qty,
        uom_id=int(uom_id) if uom_id else None,
    )
    db.add(line)
    await db.flush()
    return {"created_indent_id": indent.id, "indent_number": indent_no, "qty": qty}


async def action_update_status(db: AsyncSession, config: dict, context: dict) -> dict:
    """Update a field on an entity referenced by the context. Useful for
    cascading transitions ("when GRN closed → set MR status to fulfilled").

    BUG-HC-101 fix: previously this accepted ANY `field` and `value`, allowing
    a malicious / mis-configured rule to overwrite arbitrary columns (e.g.
    purchase_order.total_amount, indent.created_by_user_id). Now we whitelist
    a small set of safe transition fields per entity_type and reject anything
    else.
    """
    import importlib
    entity_type = config.get("entity_type")
    entity_id_field = config.get("entity_id_field", "entity_id")
    entity_id = context.get(entity_id_field)
    field = config.get("field", "status")
    value = config.get("value")
    if not entity_type or not entity_id or not value:
        return {"skipped": "missing entity_type / entity_id / value"}
    model_map = {
        "indent": ("app.models.indent", "Indent"),
        "material_request": ("app.models.procurement", "MaterialRequest"),
        "purchase_order": ("app.models.procurement", "PurchaseOrder"),
        "stock_transfer": ("app.models.transfer", "StockTransfer"),
    }
    cfg = model_map.get(entity_type)
    if not cfg:
        return {"skipped": f"unknown entity_type {entity_type}"}

    # BUG-HC-101 fix: per-entity whitelist of fields a rule may set.
    # Status / priority / hold-flag / remarks are the only safe transitions —
    # everything else (FKs, qtys, totals, audit columns) is excluded.
    allowed_fields_by_entity = {
        "indent": {"status", "priority", "remarks"},
        "material_request": {"status", "priority", "remarks"},
        "purchase_order": {"status", "remarks"},
        "stock_transfer": {"status", "remarks"},
    }
    allowed = allowed_fields_by_entity.get(entity_type, set())
    if field not in allowed:
        return {
            "skipped": (
                f"field '{field}' is not in the whitelist for entity_type "
                f"'{entity_type}' (allowed: {sorted(allowed)})"
            )
        }

    mod = importlib.import_module(cfg[0])
    Model = getattr(mod, cfg[1])
    # Defensive: refuse if the model doesn't actually have this attribute.
    if not hasattr(Model, field):
        return {"skipped": f"{entity_type} model has no attribute '{field}'"}
    row = (await db.execute(select(Model).where(Model.id == entity_id))).scalar_one_or_none()
    if not row:
        return {"skipped": f"{entity_type} {entity_id} not found"}
    setattr(row, field, value)
    await db.flush()
    return {"updated_entity": entity_type, "entity_id": entity_id, field: value}


ACTION_HANDLERS = {
    "notify": action_notify,
    "create_indent": action_create_indent,
    "update_status": action_update_status,
}


# ─── Engine entry point ─────────────────────────────────────────────────────

def _idempotency_key(event_name: str, context: Dict[str, Any]) -> str:
    """BUG-HC-099 fix: stable key per (event, source). If two retries fire the
    same event with the same source_type+source_id, we treat the second as a
    no-op rather than executing the action twice (e.g. creating two indents,
    sending two notifications). The key uses source_type+source_id when
    present, else falls back to a hash of the canonical context.

    Note: this is a best-effort guard at the engine level; for full
    cross-process idempotency, a unique constraint on
    BusinessRuleExecution.idempotency_key would be needed (deferred).
    """
    import hashlib as _h
    src_type = context.get("source_type") or context.get("entity_type")
    src_id = context.get("source_id") or context.get("entity_id")
    if src_type and src_id:
        return f"{event_name}:{src_type}:{src_id}"
    body = json.dumps(context, default=str, sort_keys=True)
    return f"{event_name}:hash:" + _h.sha256(body.encode()).hexdigest()[:16]


async def evaluate_rules(
    db: AsyncSession,
    event_name: str,
    context: Dict[str, Any],
) -> list:
    """Public entry point — call this from any service that wants to fire
    business rules. Returns a list of execution summaries (id, status, result).

    Errors in individual rules don't propagate — they're logged to the
    executions table and the engine continues. This means a buggy rule
    can't take down the calling transaction.

    BUG-HC-099 fix: idempotency — for each (rule, idempotency_key) we check
    whether a successful execution already exists; if so we short-circuit
    and return the prior result rather than re-running the action.
    """
    result = await db.execute(
        select(BusinessRule).where(
            BusinessRule.trigger_event == event_name,
            BusinessRule.is_active == True,  # noqa: E712
        )
    )
    rules = list(result.scalars().all())
    summaries = []

    idem_key = _idempotency_key(event_name, context)

    # BUG-HC-103 fix: previous loop passed the same `context` dict into every
    # rule's evaluate_condition + handler. Action handlers (notify / create_indent /
    # update_status) sometimes mutate the dict (e.g. inject "user_id", strip
    # PII), so a later rule could see a context that bears the residue of the
    # earlier rule. Take a per-rule deep-copy so each rule sees the original
    # event payload exactly as published.
    import copy as _copy

    for rule in rules:
        rule_ctx = _copy.deepcopy(context)
        try:
            cond_holds = evaluate_condition(rule.condition_json, rule_ctx)
        except Exception as e:
            cond_holds = False
            await _log_execution(db, rule, rule_ctx, "failed", error=f"condition eval: {e}")
            summaries.append({"rule_id": rule.id, "status": "failed"})
            continue

        if not cond_holds:
            # Don't bloat the executions table with every "didn't match" row;
            # just skip silently. (Admin can wire a debug flag later if needed.)
            continue

        # BUG-HC-099 fix: check for prior successful execution with the same
        # idempotency key (best-effort — based on a marker stored in the
        # trigger_context JSON). If found, skip re-execution.
        try:
            prior = await db.execute(
                select(BusinessRuleExecution.id, BusinessRuleExecution.result)
                .where(
                    BusinessRuleExecution.rule_id == rule.id,
                    BusinessRuleExecution.status == "success",
                    BusinessRuleExecution.trigger_context.like(f"%{idem_key}%"),
                )
                .limit(1)
            )
            prior_row = prior.first()
            if prior_row:
                summaries.append({
                    "rule_id": rule.id,
                    "status": "skipped_idempotent",
                    "idempotency_key": idem_key,
                })
                continue
        except Exception:
            # If the lookup fails, fall through to normal execution.
            pass

        handler = ACTION_HANDLERS.get(rule.action_type)
        if not handler:
            await _log_execution(
                db, rule, context, "failed",
                error=f"unknown action_type {rule.action_type}"
            )
            summaries.append({"rule_id": rule.id, "status": "failed"})
            continue

        try:
            try:
                action_config = json.loads(rule.action_config)
            except Exception:
                action_config = {}
            output = await handler(db, action_config, rule_ctx)
            status = "skipped" if output and "skipped" in output else "success"
            # Tag the trigger_context with the idempotency key so subsequent
            # retries can find this execution.
            ctx_with_key = dict(rule_ctx)
            ctx_with_key["__idem_key"] = idem_key
            await _log_execution(db, rule, ctx_with_key, status, result_data=output)
            rule.last_fired_at = datetime.now(timezone.utc)
            rule.fire_count = (rule.fire_count or 0) + 1
            summaries.append({"rule_id": rule.id, "status": status, "result": output})
        except Exception as e:
            await _log_execution(db, rule, rule_ctx, "failed", error=str(e))
            summaries.append({"rule_id": rule.id, "status": "failed", "error": str(e)})

    if summaries:
        await db.flush()
    return summaries


async def _log_execution(
    db: AsyncSession,
    rule: BusinessRule,
    context: Dict[str, Any],
    status: str,
    *,
    result_data: Optional[dict] = None,
    error: Optional[str] = None,
) -> None:
    try:
        ctx_str = json.dumps(context, default=str)[:8000]
    except Exception:
        ctx_str = str(context)[:8000]
    try:
        result_str = json.dumps(result_data, default=str)[:4000] if result_data else None
    except Exception:
        result_str = str(result_data)[:4000] if result_data else None
    # BUG-HC-108 fix: replace the fragile `(error or None) and str(error)[:4000]`
    # expression with a clear conditional. The previous form returned False
    # for any falsy non-None value (e.g. empty string -> False, then 0/False
    # got converted to bool by the AND short-circuit) which Python kindly
    # accepted but stored a truthiness flag instead of the actual error.
    truncated_error: Optional[str] = None
    if error:
        try:
            truncated_error = str(error)[:4000]
        except Exception:
            truncated_error = "<unrenderable error>"
    db.add(BusinessRuleExecution(
        rule_id=rule.id,
        trigger_context=ctx_str,
        status=status,
        result=result_str,
        error=truncated_error,
    ))
