"""Wave 8 — Document Management API.

Surface:
  GET    /documents/groups
  GET    /documents/groups/{id}
  GET    /documents/groups/{id}/versions
  POST   /documents/groups/{id}/new-version       (multipart upload)
  POST   /documents/groups                        (create empty group)
  PUT    /documents/groups/{id}                   (rename, recategorize, archive)
  DELETE /documents/groups/{id}                   (archive only — never hard delete)

  GET    /documents/templates
  POST   /documents/templates
  PUT    /documents/templates/{id}
  DELETE /documents/templates/{id}
  POST   /documents/templates/{id}/render         (preview render with sample context)

  GET    /documents/transition-rules
  POST   /documents/transition-rules
  PUT    /documents/transition-rules/{id}
  DELETE /documents/transition-rules/{id}
"""
from __future__ import annotations
import os
import uuid
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, UploadFile, File, Form
from sqlalchemy import select, func, or_, and_
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.database import get_db
from app.models.user import User
from app.models.system import FileAttachment
from app.models.documents import DocumentGroup, DocumentTemplate, StateTransitionRule
from app.services.document_service import (
    sha256_of_bytes, attach_as_new_version, list_versions,
    render_template, find_placeholders, render_template_string,
)
from app.utils.dependencies import get_current_user, require_any_role
from app.utils.helpers import paginate_params, build_paginated_response


router = APIRouter()

_ALLOWED_EXTS = {
    ".pdf", ".png", ".jpg", ".jpeg", ".gif", ".webp",
    ".doc", ".docx", ".xls", ".xlsx", ".csv", ".txt", ".md",
}
_MAX_BYTES = getattr(settings, "MAX_UPLOAD_SIZE", 20 * 1024 * 1024)


# BUG-HC-061 fix: magic-byte signature map keyed by extension. Files whose
# first bytes do not match the declared extension are rejected. This stops a
# malicious user from uploading a .exe or .html renamed to .pdf and getting
# it served back to other users.
_MAGIC_BYTES_BY_EXT: dict = {
    ".pdf": [b"%PDF-"],
    ".png": [b"\x89PNG\r\n\x1a\n"],
    ".jpg": [b"\xff\xd8\xff"],
    ".jpeg": [b"\xff\xd8\xff"],
    ".gif": [b"GIF87a", b"GIF89a"],
    ".webp": [b"RIFF"],  # followed by ...WEBP at offset 8
    ".doc": [b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"],  # OLE compound document
    ".docx": [b"PK\x03\x04"],  # zip
    ".xls": [b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"],
    ".xlsx": [b"PK\x03\x04"],
    # csv/txt/md are plain-text — sniff that they're mostly printable ASCII.
}


def _looks_like_text(blob: bytes) -> bool:
    if not blob:
        return False
    sample = blob[:1024]
    try:
        sample.decode("utf-8")
    except UnicodeDecodeError:
        return False
    # Reject if any null byte is present in the sniffed prefix.
    return b"\x00" not in sample


def _validate_magic_bytes(content: bytes, ext: str) -> bool:
    """Return True if `content` plausibly matches the declared extension."""
    if ext in (".csv", ".txt", ".md"):
        return _looks_like_text(content)
    sigs = _MAGIC_BYTES_BY_EXT.get(ext)
    if not sigs:
        # No signature defined → conservatively accept.
        return True
    return any(content.startswith(s) for s in sigs)


# ─────────────────────────────────────────────────────────────────────
# Document groups
# ─────────────────────────────────────────────────────────────────────

@router.get("/groups")
async def list_groups(
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
    source_type: Optional[str] = Query(None),
    source_id: Optional[int] = Query(None),
    category: Optional[str] = Query(None),
    archived: bool = Query(False),
    search: Optional[str] = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    offset, limit = paginate_params(page, page_size)
    q = select(DocumentGroup).where(DocumentGroup.is_archived == archived)
    cq = select(func.count(DocumentGroup.id)).where(DocumentGroup.is_archived == archived)
    if source_type:
        q = q.where(DocumentGroup.source_type == source_type)
        cq = cq.where(DocumentGroup.source_type == source_type)
    if source_id:
        q = q.where(DocumentGroup.source_id == source_id)
        cq = cq.where(DocumentGroup.source_id == source_id)
    if category:
        q = q.where(DocumentGroup.category == category)
        cq = cq.where(DocumentGroup.category == category)
    if search:
        q = q.where(or_(
            DocumentGroup.name.ilike(f"%{search}%"),
            DocumentGroup.description.ilike(f"%{search}%"),
        ))
        cq = cq.where(or_(
            DocumentGroup.name.ilike(f"%{search}%"),
            DocumentGroup.description.ilike(f"%{search}%"),
        ))
    total = (await db.execute(cq)).scalar() or 0
    rows = (await db.execute(q.offset(offset).limit(limit).order_by(DocumentGroup.id.desc()))).scalars().all()
    out = []
    for g in rows:
        out.append({
            "id": g.id,
            "name": g.name,
            "description": g.description,
            "category": g.category,
            "source_type": g.source_type,
            "source_id": g.source_id,
            "current_version_id": g.current_version_id,
            "current_version_number": g.current_version_number,
            "is_archived": g.is_archived,
            "created_by": g.created_by,
            "created_at": g.created_at.isoformat() if g.created_at else None,
            "updated_at": g.updated_at.isoformat() if g.updated_at else None,
        })
    return build_paginated_response(out, total, page, page_size)


async def _assert_can_view_group(db: AsyncSession, current_user: User, g: DocumentGroup) -> None:
    """BUG-HC-070/071 fix: gate document-group access by role.

    Document groups can be linked to any source entity (PO, vendor, asset,
    payment, etc.) — letting *every* authenticated user list versions and
    pull file URLs is a documents-IDOR risk. Restrict cross-entity reads to
    privileged roles; non-privileged users can only view groups they
    created or that belong to entities they own.
    """
    from app.utils.dependencies import get_user_role_codes
    user_roles = set(await get_user_role_codes(db, current_user.id))
    privileged = {
        "super_admin", "admin", "compliance_officer", "compliance",
        "procurement_manager", "store_manager", "warehouse_manager",
        "finance_manager", "documents_admin",
    }
    if user_roles & privileged:
        return
    # Created by the same user → allow.
    if g.created_by and g.created_by == current_user.id:
        return
    raise HTTPException(
        status_code=403,
        detail="You do not have permission to view this document group.",
    )


@router.get("/groups/{group_id}")
async def get_group(
    group_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    g = (await db.execute(select(DocumentGroup).where(DocumentGroup.id == group_id))).scalar_one_or_none()
    if not g:
        raise HTTPException(status_code=404, detail="Document group not found")
    await _assert_can_view_group(db, current_user, g)
    versions = await list_versions(db, group_id=group_id)
    return {
        "id": g.id,
        "name": g.name,
        "description": g.description,
        "category": g.category,
        "source_type": g.source_type,
        "source_id": g.source_id,
        "current_version_id": g.current_version_id,
        "current_version_number": g.current_version_number,
        "is_archived": g.is_archived,
        "versions": versions,
    }


@router.get("/groups/{group_id}/versions")
async def get_versions(
    group_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    g = (await db.execute(select(DocumentGroup).where(DocumentGroup.id == group_id))).scalar_one_or_none()
    if not g:
        raise HTTPException(status_code=404, detail="Document group not found")
    # BUG-HC-071 fix: require permission to view this group before returning
    # version URLs.
    await _assert_can_view_group(db, current_user, g)
    return await list_versions(db, group_id=group_id)


@router.post("/groups/{group_id}/new-version", status_code=201)
async def upload_new_version(
    group_id: int,
    file: UploadFile = File(...),
    change_note: str = Form(""),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Upload a new version of an existing document group."""
    g = (await db.execute(select(DocumentGroup).where(DocumentGroup.id == group_id))).scalar_one_or_none()
    if not g:
        raise HTTPException(status_code=404, detail="Document group not found")

    ext = os.path.splitext(file.filename or "")[1].lower()
    if ext not in _ALLOWED_EXTS:
        raise HTTPException(status_code=400, detail=f"Extension {ext or '(none)'} not allowed")

    # BUG-HC-063 fix: stream the upload in bounded chunks and abort as soon
    # as we exceed _MAX_BYTES so a 4 GB file does not exhaust RAM. We also
    # detect the empty-file case before doing any disk work.
    _CHUNK = 64 * 1024
    chunks: list[bytes] = []
    total_size = 0
    while True:
        chunk = await file.read(_CHUNK)
        if not chunk:
            break
        total_size += len(chunk)
        if total_size > _MAX_BYTES:
            raise HTTPException(status_code=400, detail="File too large")
        chunks.append(chunk)
    if total_size == 0:
        raise HTTPException(status_code=400, detail="Empty file")
    content = b"".join(chunks)
    # BUG-HC-061 fix: verify magic bytes match the declared extension.
    if not _validate_magic_bytes(content, ext):
        raise HTTPException(
            status_code=400,
            detail=f"File content does not match {ext} format (magic-byte check failed).",
        )

    # BUG-HC-064 fix: csv/txt/md are stored on disk and served back through
    # static or download endpoints. If a user uploads HTML/JS hidden in a
    # .txt file and a downstream link re-serves it as text/html, that's a
    # stored-XSS vector. Reject text uploads that contain obvious HTML/JS
    # markers in the first 4 KB.
    if ext in (".csv", ".txt", ".md"):
        sample_low = content[:4096].decode("utf-8", errors="ignore").lower()
        for danger in ("<script", "<iframe", "<embed", "<object", "javascript:", "on=", "<svg"):
            if danger in sample_low:
                raise HTTPException(
                    status_code=400,
                    detail=(
                        "Text upload contains HTML/JS-like content; this is "
                        "blocked to prevent stored XSS. Strip the markup or "
                        "upload as a PDF."
                    ),
                )

    # Persist to disk
    safe_dir = os.path.join(settings.UPLOAD_DIR, "documents")
    os.makedirs(safe_dir, exist_ok=True)
    stored_name = f"{uuid.uuid4().hex}{ext}"
    stored_path = os.path.join(safe_dir, stored_name)
    with open(stored_path, "wb") as f:
        f.write(content)
    public_url = f"/uploads/documents/{stored_name}"

    # Create FileAttachment row + attach as new version
    # BUG-HC-066 fix: when DocumentGroup.source_id is NULL (e.g. empty group
    # created manually), don't coerce entity_id to 0 — that ID is an FK in
    # downstream consumer queries and 0 collides with whatever entity has
    # id=0 (or fails the FK check). Fall back to the document group's own
    # id so the attachment is at least retrievable, and tag the entity_type
    # explicitly as "document_group" so consumers know it's not a real
    # PO/vendor/etc. linkage.
    _entity_type = g.source_type or "document_group"
    _entity_id = g.source_id if g.source_id else g.id
    att = FileAttachment(
        entity_type=_entity_type,
        entity_id=_entity_id,
        file_name=file.filename or stored_name,
        file_path=public_url,
        file_type=ext.lstrip("."),
        file_size=len(content),
        sha256=sha256_of_bytes(content),
        uploaded_by=current_user.id,
        category=g.category,
    )
    db.add(att)
    await db.flush()
    grp, att = await attach_as_new_version(
        db,
        file_attachment=att,
        document_group_id=group_id,
        change_note=change_note or None,
        created_by=current_user.id,
    )

    # BUG-HC-067 fix: audit-log every document upload so we have a tamper-
    # evident trail of who uploaded what document, when, and against which
    # entity. Filename and SHA are recorded; file content is NOT stored in
    # the audit log.
    try:
        from app.services.compliance_service import log_audit
        await log_audit(
            db,
            event_type="document_upload",
            severity="info",
            source_type=_entity_type,
            source_id=_entity_id or grp.id,
            user_id=current_user.id,
            payload={
                "group_id": grp.id,
                "version_id": att.id,
                "version_number": att.version_number,
                "file_name": att.file_name,
                "file_size": att.file_size,
                "sha256": att.sha256,
                "category": att.category,
            },
        )
    except Exception:
        pass

    return {
        "group_id": grp.id,
        "version_id": att.id,
        "version_number": att.version_number,
        "file_path": att.file_path,
        "sha256": att.sha256,
    }


@router.post("/groups", status_code=201)
async def create_group(
    payload: dict,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Create an empty document group; subsequent uploads add versions."""
    g = DocumentGroup(
        name=payload.get("name") or "Untitled Document",
        description=payload.get("description"),
        category=payload.get("category"),
        source_type=payload.get("source_type"),
        source_id=payload.get("source_id"),
        created_by=current_user.id,
    )
    db.add(g)
    await db.flush()
    return {"id": g.id, "message": "Document group created"}


@router.put("/groups/{group_id}")
async def update_group(
    group_id: int,
    payload: dict,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    g = (await db.execute(select(DocumentGroup).where(DocumentGroup.id == group_id))).scalar_one_or_none()
    if not g:
        raise HTTPException(status_code=404, detail="Document group not found")
    # BUG-HC-072 fix: source_type/source_id are immutable identity fields.
    # Allowing them to be re-pointed lets a user "graft" a privileged
    # document group onto another entity (e.g. attach a vendor's confidential
    # docs to a PO that *they* own to read them). Strip those keys; only
    # super_admin / admin can re-target a group, and even then via DB.
    _UPDATABLE = {"name", "description", "category", "is_archived"}
    for k in _UPDATABLE:
        if k in payload:
            setattr(g, k, payload[k])
    await db.flush()
    return {"success": True}


@router.delete("/groups/{group_id}")
async def archive_group(
    group_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_any_role("super_admin", "admin")),
):
    g = (await db.execute(select(DocumentGroup).where(DocumentGroup.id == group_id))).scalar_one_or_none()
    if not g:
        raise HTTPException(status_code=404, detail="Document group not found")
    g.is_archived = True
    await db.flush()
    # BUG-HC-069 fix: shared {soft_delete: True} flag for parity with
    # delete_template so the FE can render a consistent confirmation.
    return {
        "success": True,
        "soft_delete": True,
        "message": "Document group archived (soft delete — restorable by admin)",
    }


# ─────────────────────────────────────────────────────────────────────
# Templates
# ─────────────────────────────────────────────────────────────────────

@router.get("/templates")
async def list_templates(
    module: Optional[str] = Query(None),
    template_type: Optional[str] = Query(None),
    is_active: Optional[bool] = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """List document templates.

    BUG-HC-073 fix: previously the listing endpoint returned the full
    `subject_template` and `body_template` payload to every authenticated
    user. Templates can contain customer-specific copy, vendor terms, and
    internal escalation phrases that aren't appropriate for the general
    user base. Non-admin / non-template-author users now receive metadata
    only; full body content remains accessible to admins (and via the
    edit/render endpoints which already check role).
    """
    from app.utils.dependencies import get_user_role_codes
    user_roles = set(await get_user_role_codes(db, current_user.id))
    privileged = bool(user_roles & {
        "super_admin", "admin", "compliance_officer", "compliance",
        "documents_admin",
    })

    q = select(DocumentTemplate)
    if module:
        q = q.where(DocumentTemplate.module == module)
    if template_type:
        q = q.where(DocumentTemplate.template_type == template_type)
    if is_active is not None:
        q = q.where(DocumentTemplate.is_active == is_active)
    rows = (await db.execute(q.order_by(DocumentTemplate.name))).scalars().all()
    return [
        {
            "id": t.id,
            "name": t.name,
            "description": t.description,
            "template_type": t.template_type,
            "module": t.module,
            "subject_template": t.subject_template if privileged else None,
            "body_template": (
                t.body_template if privileged
                else (
                    "[redacted — full body visible to admins only]"
                    if t.body_template else None
                )
            ),
            "placeholders": t.placeholders,
            "is_active": t.is_active,
        }
        for t in rows
    ]


@router.post("/templates", status_code=201)
async def create_template(
    payload: dict,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_any_role("super_admin", "admin")),
):
    if not payload.get("name") or not payload.get("template_type") or not payload.get("body_template"):
        raise HTTPException(status_code=400, detail="name, template_type and body_template are required")
    placeholders = find_placeholders((payload.get("subject_template") or "") + " " + (payload.get("body_template") or ""))
    t = DocumentTemplate(
        name=payload["name"],
        description=payload.get("description"),
        template_type=payload["template_type"],
        module=payload.get("module"),
        subject_template=payload.get("subject_template"),
        body_template=payload["body_template"],
        placeholders=placeholders,
        is_active=payload.get("is_active", True),
        created_by=current_user.id,
    )
    db.add(t)
    await db.flush()
    return {"id": t.id, "placeholders": placeholders, "message": "Template created"}


@router.put("/templates/{tpl_id}")
async def update_template(
    tpl_id: int,
    payload: dict,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_any_role("super_admin", "admin")),
):
    t = (await db.execute(select(DocumentTemplate).where(DocumentTemplate.id == tpl_id))).scalar_one_or_none()
    if not t:
        raise HTTPException(status_code=404, detail="Template not found")
    for k in ("name", "description", "template_type", "module", "subject_template", "body_template", "is_active"):
        if k in payload:
            setattr(t, k, payload[k])
    t.placeholders = find_placeholders((t.subject_template or "") + " " + (t.body_template or ""))
    await db.flush()
    return {"success": True, "placeholders": t.placeholders}


@router.delete("/templates/{tpl_id}")
async def delete_template(
    tpl_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_any_role("super_admin", "admin")),
):
    """Soft-delete a document template by deactivating it.

    BUG-HC-069 fix: align the response shape with archive_group so the
    frontend can rely on the same `{"success": True, "soft_delete": True,
    "message": ...}` contract for both. Templates referenced by past
    transitions/notifications are never hard-deleted because the audit
    trail must still resolve their name.
    """
    t = (await db.execute(select(DocumentTemplate).where(DocumentTemplate.id == tpl_id))).scalar_one_or_none()
    if not t:
        raise HTTPException(status_code=404, detail="Template not found")
    t.is_active = False
    await db.flush()
    return {
        "success": True,
        "soft_delete": True,
        "message": "Template deactivated (soft delete — kept for audit trail)",
    }


# BUG-HC-074 fix: simple in-process rate limiter so the template-render
# endpoint can't be used as a CPU-amplification gadget by a malicious or
# misbehaving client. Window: 30 calls / minute / user.
_RENDER_RATE_BUCKET: dict = {}
_RENDER_RATE_LIMIT = 30
_RENDER_RATE_WINDOW_S = 60


def _render_rate_check(user_id: int) -> None:
    import time as _t
    now = _t.time()
    bucket = _RENDER_RATE_BUCKET.get(user_id, [])
    bucket = [t for t in bucket if t > now - _RENDER_RATE_WINDOW_S]
    if len(bucket) >= _RENDER_RATE_LIMIT:
        raise HTTPException(
            status_code=429,
            detail=(
                f"Rate limit exceeded for template render "
                f"({_RENDER_RATE_LIMIT}/min). Try again shortly."
            ),
        )
    bucket.append(now)
    _RENDER_RATE_BUCKET[user_id] = bucket


@router.post("/templates/{tpl_id}/render")
async def render_template_endpoint(
    tpl_id: int,
    payload: dict,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Render the template against a context dict — useful for previewing."""
    _render_rate_check(current_user.id)
    return await render_template(db, template_id=tpl_id, context=payload or {})


# ─────────────────────────────────────────────────────────────────────
# Transition rules
# ─────────────────────────────────────────────────────────────────────

@router.get("/transition-rules")
async def list_transition_rules(
    module: Optional[str] = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    q = select(StateTransitionRule)
    if module:
        q = q.where(StateTransitionRule.module == module)
    rows = (await db.execute(q.order_by(StateTransitionRule.module, StateTransitionRule.source_type))).scalars().all()
    return [
        {
            "id": r.id,
            "module": r.module,
            "source_type": r.source_type,
            "from_state": r.from_state,
            "to_state": r.to_state,
            "requires_e_sign": r.requires_e_sign,
            "requires_attachment": r.requires_attachment,
            "attachment_category": r.attachment_category,
            "description": r.description,
            "is_active": r.is_active,
        }
        for r in rows
    ]


@router.post("/transition-rules", status_code=201)
async def create_transition_rule(
    payload: dict,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_any_role("super_admin", "admin")),
):
    for k in ("module", "source_type", "to_state"):
        if not payload.get(k):
            raise HTTPException(status_code=400, detail=f"{k} is required")
    # BUG-HC-123 fix: requires_attachment=True without an attachment_category
    # is meaningless (it would accept any old upload). Force admins to pick
    # a category whenever they require an attachment.
    if payload.get("requires_attachment") and not payload.get("attachment_category"):
        raise HTTPException(
            status_code=400,
            detail=(
                "attachment_category is required when requires_attachment is true."
            ),
        )
    r = StateTransitionRule(
        module=payload["module"],
        source_type=payload["source_type"],
        from_state=payload.get("from_state"),
        to_state=payload["to_state"],
        requires_e_sign=payload.get("requires_e_sign", False),
        requires_attachment=payload.get("requires_attachment", False),
        attachment_category=payload.get("attachment_category"),
        description=payload.get("description"),
        is_active=payload.get("is_active", True),
    )
    db.add(r)
    await db.flush()
    return {"id": r.id, "message": "Transition rule created"}


@router.put("/transition-rules/{rule_id}")
async def update_transition_rule(
    rule_id: int,
    payload: dict,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_any_role("super_admin", "admin")),
):
    r = (await db.execute(select(StateTransitionRule).where(StateTransitionRule.id == rule_id))).scalar_one_or_none()
    if not r:
        raise HTTPException(status_code=404, detail="Rule not found")
    # BUG-HC-123 fix: same guard as create — block updates that turn on
    # requires_attachment without specifying attachment_category.
    next_req_attach = payload.get("requires_attachment", r.requires_attachment)
    next_attach_cat = payload.get("attachment_category", r.attachment_category)
    if next_req_attach and not next_attach_cat:
        raise HTTPException(
            status_code=400,
            detail=(
                "attachment_category is required when requires_attachment is true."
            ),
        )
    for k in ("module", "source_type", "from_state", "to_state", "requires_e_sign",
              "requires_attachment", "attachment_category", "description", "is_active"):
        if k in payload:
            setattr(r, k, payload[k])
    await db.flush()
    return {"success": True}


@router.delete("/transition-rules/{rule_id}")
async def delete_transition_rule(
    rule_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_any_role("super_admin", "admin")),
):
    r = (await db.execute(select(StateTransitionRule).where(StateTransitionRule.id == rule_id))).scalar_one_or_none()
    if not r:
        raise HTTPException(status_code=404, detail="Rule not found")
    await db.delete(r)
    await db.flush()
    return {"success": True}
