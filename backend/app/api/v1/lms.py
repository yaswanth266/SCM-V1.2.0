"""LMS — Learning Management System.

Returns short tutorial videos relevant to the logged-in user's roles.
Each video row carries a CSV of role codes; 'all' means everyone sees it.
"""
import os
import re
import uuid
from pathlib import Path
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from pydantic import BaseModel
from sqlalchemy import select, Column, BigInteger, String, Text, Boolean, Integer, DateTime
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import Base, get_db
from app.models.user import User
from app.utils.dependencies import get_current_user, get_user_role_codes


router = APIRouter()


class LmsVideo(Base):
    __tablename__ = "lms_videos"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    code = Column(String(80), unique=True, nullable=False)
    title = Column(String(255), nullable=False)
    description = Column(Text)
    role_codes = Column(String(500), nullable=False, default="all")
    video_url = Column(String(500), nullable=False)
    duration_seconds = Column(Integer)
    sort_order = Column(Integer, default=0)
    module = Column(String(80))
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime)


def _parse_roles(csv: str) -> set:
    # BUG-HC-090 fix: canonicalize on BOTH sides (lowercase + strip) so a
    # video tagged "Pharmacist " (trailing space, capital P) matches a user
    # whose role code is "pharmacist". Same _norm() helper is applied to
    # the user-side role set.
    return {r.strip().lower() for r in (csv or "").split(",") if r.strip()}


def _norm(roles) -> set:
    return {(r or "").strip().lower() for r in roles if r}


@router.get("/videos")
async def list_videos_for_user(
    module: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Return the videos visible to the logged-in user, ordered by sort_order.
    A video is visible if its role_codes is 'all' or contains any of the
    user's role codes."""
    # BUG-HC-090 fix: normalize the user's role codes (strip + lower) so
    # whitespace/casing differences between LmsVideo.role_codes and the
    # user_roles set don't silently hide videos.
    user_roles = _norm(await get_user_role_codes(db, current_user.id))

    q = select(LmsVideo).where(LmsVideo.is_active == True)  # noqa
    if module:
        q = q.where(LmsVideo.module == module)
    rows = (await db.execute(q.order_by(LmsVideo.sort_order, LmsVideo.id))).scalars().all()

    visible = []
    for v in rows:
        allowed = _parse_roles(v.role_codes)
        # BUG-HC-091 fix: previously the `or "super_admin" in user_roles`
        # branch let super_admin see *every* video, even ones explicitly
        # role-restricted. That defeats the purpose of role-tagging when an
        # admin wants to assign videos targeted at a specific persona.
        # Super_admin still sees role="all" and any video tagged super_admin,
        # but a video tagged exclusively (say) "pharmacist" no longer leaks
        # into the admin view. Admin CRUD endpoints already let admins manage
        # the catalogue without seeing every learner's filtered list.
        if "all" in allowed or (allowed & user_roles):
            visible.append({
                "id": v.id,
                "code": v.code,
                "title": v.title,
                "description": v.description,
                # BUG-HC-092 fix: don't echo the raw role_codes CSV taxonomy
                # back to non-admin users. Strip to the intersection between
                # the video's tags and what the user actually has, so the
                # response can't be used to enumerate the org's role list.
                "role_codes": (
                    v.role_codes
                    if (user_roles & {"super_admin", "admin"})
                    else ",".join(sorted(allowed & user_roles)) or "all"
                ),
                "video_url": v.video_url,
                "duration_seconds": v.duration_seconds,
                "module": v.module,
                "sort_order": v.sort_order,
            })
    return {
        "items": visible,
        "user_roles": sorted(user_roles),
        "count": len(visible),
    }


# ---------- Admin CRUD ----------

class VideoPayload(BaseModel):
    code: str
    title: str
    description: Optional[str] = None
    role_codes: str = "all"
    video_url: str
    duration_seconds: Optional[int] = None
    sort_order: int = 0
    module: Optional[str] = None
    is_active: bool = True


def _admin_only(roles: set):
    if not (roles & {"super_admin", "admin"}):
        raise HTTPException(403, "Admin only")


@router.post("/videos", status_code=201)
async def create_video(
    payload: VideoPayload,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    _admin_only(_norm(await get_user_role_codes(db, current_user.id)))
    # BUG-HC-094 fix: previous SELECT-then-INSERT pattern is a TOCTOU race —
    # two concurrent admin posts with the same code would both pass the
    # duplicate check. Wrap the INSERT in try/except IntegrityError so the
    # DB unique constraint becomes the source of truth.
    dup = (await db.execute(select(LmsVideo).where(LmsVideo.code == payload.code))).scalar_one_or_none()
    if dup:
        raise HTTPException(409, f"Video code '{payload.code}' already exists")
    v = LmsVideo(**payload.model_dump())
    db.add(v)
    try:
        await db.flush()
    except Exception as exc:
        # IntegrityError or any DB-level unique violation
        from sqlalchemy.exc import IntegrityError
        if isinstance(exc, IntegrityError):
            await db.rollback()
            raise HTTPException(409, f"Video code '{payload.code}' already exists")
        raise
    return {"id": v.id, "message": "Video added"}


@router.put("/videos/{video_id}")
async def update_video(
    video_id: int, payload: VideoPayload,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    _admin_only(_norm(await get_user_role_codes(db, current_user.id)))
    v = (await db.execute(select(LmsVideo).where(LmsVideo.id == video_id))).scalar_one_or_none()
    if not v:
        raise HTTPException(404, "Video not found")
    for k, val in payload.model_dump().items():
        setattr(v, k, val)
    await db.flush()
    return {"id": v.id, "message": "Video updated"}


@router.delete("/videos/{video_id}")
async def delete_video(
    video_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    _admin_only(_norm(await get_user_role_codes(db, current_user.id)))
    v = (await db.execute(select(LmsVideo).where(LmsVideo.id == video_id))).scalar_one_or_none()
    if not v:
        raise HTTPException(404, "Video not found")
    v.is_active = False
    await db.flush()
    return {"message": "Video deactivated"}


# ---------- Upload (admin replaces a tutorial's media file) ----------

UPLOAD_ROOT = Path("/home/ubuntu/erp/uploads/lms")
ALLOWED_EXTS = {".mp4", ".webm", ".mov", ".m4v", ".gif"}
MAX_BYTES = 200 * 1024 * 1024  # 200 MB


@router.post("/videos/{video_id}/upload")
async def upload_video_media(
    video_id: int,
    file: UploadFile = File(...),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Admin uploads MP4/WebM/MOV/M4V/GIF for a tutorial. Stores under
    /uploads/lms/<code>-<uuid>.ext and overwrites the video's video_url.
    """
    _admin_only(_norm(await get_user_role_codes(db, current_user.id)))

    v = (await db.execute(select(LmsVideo).where(LmsVideo.id == video_id))).scalar_one_or_none()
    if not v:
        raise HTTPException(404, "Video not found")

    fn = (file.filename or "").lower()
    ext = "." + fn.rsplit(".", 1)[-1] if "." in fn else ""
    if ext not in ALLOWED_EXTS:
        raise HTTPException(415, f"Only {sorted(ALLOWED_EXTS)} files allowed")

    # Read with size cap
    payload = await file.read()
    if len(payload) > MAX_BYTES:
        raise HTTPException(413, f"File too large (max {MAX_BYTES // (1024*1024)} MB)")
    if not payload:
        raise HTTPException(400, "Empty file")

    UPLOAD_ROOT.mkdir(parents=True, exist_ok=True)
    safe_code = re.sub(r"[^A-Za-z0-9_-]", "_", v.code or f"vid{video_id}")
    fname = f"{safe_code}-{uuid.uuid4().hex[:8]}{ext}"
    target = UPLOAD_ROOT / fname
    with target.open("wb") as fh:
        fh.write(payload)

    v.video_url = f"/uploads/lms/{fname}"
    await db.flush()
    return {
        "id": v.id,
        "video_url": v.video_url,
        "size_bytes": len(payload),
        "message": "Media uploaded",
    }
