"""Wave 8 — document management service.

Handles:
  - Versioning: ensure each new upload appends a version, marks previous
    versions is_current_version=False, updates document_groups.current_version_*
  - Template rendering: simple {placeholder} substitution against a context dict
  - State-transition gate: assert e-sign / required attachment per rule
"""
from __future__ import annotations
import hashlib
import logging
import re
from typing import Optional, Sequence
from datetime import datetime, timezone

from fastapi import HTTPException
from sqlalchemy import select, and_, or_, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.system import FileAttachment
from app.models.documents import DocumentGroup, DocumentTemplate, StateTransitionRule
from app.models.compliance import ESignature
from app.services.compliance_service import assert_reauth_and_sign


logger = logging.getLogger(__name__)


PLACEHOLDER_RE = re.compile(r"\{([a-zA-Z0-9_.]+)\}")


# ─────────────────────────────────────────────────────────────────────
# Versioning
# ─────────────────────────────────────────────────────────────────────

def sha256_of_bytes(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()


async def attach_as_new_version(
    db: AsyncSession,
    *,
    file_attachment: FileAttachment,
    document_group_id: Optional[int],
    name: Optional[str] = None,
    category: Optional[str] = None,
    change_note: Optional[str] = None,
    created_by: Optional[int] = None,
) -> tuple[DocumentGroup, FileAttachment]:
    """Make `file_attachment` the new current version of either an existing
    DocumentGroup (when document_group_id is given) or a freshly-created group.
    """
    if document_group_id:
        # New version of an existing group.
        # BUG-HC-068 fix: take a row-level lock on the document group while we
        # compute the next version number, so two concurrent uploads can't
        # both pick the same value and produce duplicate version numbers.
        grp_row = await db.execute(
            select(DocumentGroup)
            .where(DocumentGroup.id == document_group_id)
            .with_for_update()
        )
        grp = grp_row.scalar_one_or_none()
        if not grp:
            raise HTTPException(status_code=404, detail=f"Document group {document_group_id} not found")
        # Mark all previous versions in this group as non-current
        await db.execute(
            update(FileAttachment)
            .where(FileAttachment.document_group_id == grp.id)
            .values(is_current_version=False)
        )
        new_version_number = (grp.current_version_number or 0) + 1
    else:
        # Brand-new group
        grp = DocumentGroup(
            name=name or file_attachment.file_name,
            category=category or file_attachment.category,
            source_type=file_attachment.entity_type,
            source_id=file_attachment.entity_id or None,
            current_version_number=0,
            created_by=created_by,
        )
        db.add(grp)
        await db.flush()
        new_version_number = 1

    file_attachment.document_group_id = grp.id
    file_attachment.version_number = new_version_number
    file_attachment.is_current_version = True
    if change_note:
        file_attachment.change_note = change_note
    if category and not file_attachment.category:
        file_attachment.category = category
    await db.flush()

    grp.current_version_id = file_attachment.id
    grp.current_version_number = new_version_number
    grp.updated_at = datetime.now(timezone.utc)
    await db.flush()
    return grp, file_attachment


async def list_versions(db: AsyncSession, *, group_id: int) -> list[dict]:
    rows = await db.execute(
        select(FileAttachment).where(FileAttachment.document_group_id == group_id)
        .order_by(FileAttachment.version_number.desc())
    )
    out = []
    for v in rows.scalars().all():
        out.append({
            "id": v.id,
            "version_number": v.version_number,
            "file_name": v.file_name,
            "file_path": v.file_path,
            "file_type": v.file_type,
            "file_size": v.file_size,
            "sha256": v.sha256,
            "change_note": v.change_note,
            "is_current_version": v.is_current_version,
            "uploaded_by": v.uploaded_by,
            "created_at": v.created_at.isoformat() if v.created_at else None,
        })
    return out


# ─────────────────────────────────────────────────────────────────────
# Template rendering
# ─────────────────────────────────────────────────────────────────────

def _resolve_path(context: dict, path: str):
    """Resolve dotted path 'order.vendor.name' against a nested dict."""
    cur = context
    for part in path.split("."):
        if cur is None:
            return None
        if isinstance(cur, dict):
            cur = cur.get(part)
        else:
            cur = getattr(cur, part, None)
    return cur


def render_template_string(template_str: str, context: dict) -> str:
    """Substitute {placeholder} or {nested.path} from context. Missing keys
    render as the literal token (e.g. '{missing}') so editors can spot them.
    """
    if not template_str:
        return ""

    def repl(m):
        key = m.group(1)
        v = _resolve_path(context, key)
        if v is None:
            return m.group(0)
        return str(v)

    return PLACEHOLDER_RE.sub(repl, template_str)


def find_placeholders(template_str: str) -> list[str]:
    if not template_str:
        return []
    return sorted(set(PLACEHOLDER_RE.findall(template_str)))


async def render_template(
    db: AsyncSession,
    *,
    template_id: int,
    context: dict,
) -> dict:
    row = await db.execute(select(DocumentTemplate).where(DocumentTemplate.id == template_id))
    tpl = row.scalar_one_or_none()
    if not tpl:
        raise HTTPException(status_code=404, detail="Template not found")
    if not tpl.is_active:
        raise HTTPException(status_code=400, detail="Template is not active")
    return {
        "id": tpl.id,
        "name": tpl.name,
        "template_type": tpl.template_type,
        "subject": render_template_string(tpl.subject_template or "", context),
        "body": render_template_string(tpl.body_template or "", context),
    }


# ─────────────────────────────────────────────────────────────────────
# Transition gate
# ─────────────────────────────────────────────────────────────────────

async def get_transition_rule(
    db: AsyncSession,
    *,
    module: str,
    source_type: str,
    from_state: Optional[str],
    to_state: str,
) -> Optional[StateTransitionRule]:
    """Find the most-specific active rule. Specific from_state beats NULL."""
    q = select(StateTransitionRule).where(
        StateTransitionRule.is_active == True,  # noqa: E712
        StateTransitionRule.module == module,
        StateTransitionRule.source_type == source_type,
        StateTransitionRule.to_state == to_state,
        or_(
            StateTransitionRule.from_state == from_state,
            StateTransitionRule.from_state.is_(None),
        ),
    )
    rows = (await db.execute(q)).scalars().all()
    if not rows:
        return None
    rows.sort(key=lambda r: 1 if r.from_state else 0, reverse=True)
    return rows[0]


async def assert_transition_compliance(
    db: AsyncSession,
    *,
    user,
    module: str,
    source_type: str,
    source_id: int,
    from_state: Optional[str],
    to_state: str,
    submitted_password: Optional[str] = None,
    payload_for_sign: Optional[dict] = None,
    client_ip: Optional[str] = None,
) -> Optional[ESignature]:
    """Enforce the rule for this transition. If e-sign required, capture it.
    Raises HTTPException on missing requirements. Returns the ESignature row
    when one was created, else None.
    """
    rule = await get_transition_rule(
        db,
        module=module, source_type=source_type,
        from_state=from_state, to_state=to_state,
    )
    if not rule:
        return None

    # Required attachment
    if rule.requires_attachment:
        # BUG-HC-075 fix: only accept an attachment uploaded recently (since
        # the entity entered its from_state) — not just any historical
        # attachment of the right category. We approximate "recent" as
        # within the last 365 days; for a tighter contract, callers can
        # supply an explicit since_date via payload_for_sign["__since"].
        from datetime import datetime as _dt, timedelta as _td, timezone as _tz
        since_cutoff = _dt.now(_tz.utc) - _td(days=365)
        if payload_for_sign and isinstance(payload_for_sign, dict):
            override = payload_for_sign.get("__since")
            if isinstance(override, str):
                try:
                    since_cutoff = _dt.fromisoformat(override)
                except Exception:
                    pass

        attach_q = select(FileAttachment).where(
            FileAttachment.entity_type == source_type,
            FileAttachment.entity_id == source_id,
            FileAttachment.is_current_version == True,  # noqa: E712
            FileAttachment.created_at >= since_cutoff,
        )
        if rule.attachment_category:
            attach_q = attach_q.where(FileAttachment.category == rule.attachment_category)
        att = (await db.execute(attach_q.limit(1))).scalar_one_or_none()
        if not att:
            cat_msg = f" of category '{rule.attachment_category}'" if rule.attachment_category else ""
            raise HTTPException(
                status_code=400,
                detail=(
                    f"This transition requires a recent attachment{cat_msg}. "
                    "Upload a current supporting document (or re-upload the "
                    "existing one), then resubmit."
                ),
            )

    # Required e-sign
    if rule.requires_e_sign:
        if not submitted_password:
            raise HTTPException(
                status_code=428,  # Precondition Required
                detail=(
                    "This state transition requires e-signature. "
                    "Re-enter your password to confirm."
                ),
            )
        sig = await assert_reauth_and_sign(
            db,
            user=user,
            submitted_password=submitted_password,
            source_type=source_type,
            source_id=source_id,
            payload=payload_for_sign or {"from": from_state, "to": to_state},
            client_ip=client_ip,
        )
        return sig

    return None
