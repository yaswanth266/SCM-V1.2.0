"""Separation of Duties enforcement helpers.

Created 2026-04-30 as part of the BHSPL SCM workflow rebuild (Task 4).

Policy (per spec, Standard SoD with super-admin bypass):

    raiser   != L1                 (already enforced by approval workflow)
    L1       != L2                 (already enforced by approval workflow)
    L2       != MI issuer          (NEW)
    MI iss   != Outward QC         (NEW)
    PO crt   != PO approver        (NEW)
    GRN do   != Inward QC          (NEW)
    Ack      == raiser only        (NEW)

Audit gap (TODO): super-admin bypass currently writes only to the Python
'sod' logger (which routes to journalctl in prod). Spec §4.4 calls for
writes to ``activity_logs`` table; that DB sink is a follow-up task
(scheduled before Phase 5 ships). Until then, audit reviewers should
grep ``journalctl -u bhspl-backend`` for ``sod_bypass``.

Super-admin bypasses each check, but the
bypass writes a warning to the 'sod' logger so audit can ingest it.

Public API:
    enforce_different_user(approver_id, actor_id, check_name, is_super_admin)
        -> raises HTTPException(403) if same user; logs bypass if super.
    enforce_same_user(expected_user_id, actor_id, check_name, is_super_admin)
        -> raises HTTPException(403) if different user; logs bypass if super.
    sod_bypass_logged(check_name, **kw)
        -> writes a warning line to the 'sod' logger.

These functions are pure helpers; FastAPI dependency wiring lives in
the endpoint code (Tasks 9, 12-17).
"""
from __future__ import annotations
import logging
from fastapi import HTTPException


logger = logging.getLogger('sod')


def enforce_different_user(
    *,
    approver_id: int | None,
    actor_id: int | None,
    check_name: str,
    is_super_admin: bool = False,
) -> None:
    """Block the action if approver and actor are the same person.

    Used at SoD checkpoints where the human who approved upstream must
    not also be the human who acts on the result (e.g. L2 approver
    cannot also be the MI issuer).

    A zero/None ``approver_id`` is treated as "no prior approver",
    which never collides with a real ``actor_id``. A None or non-positive
    ``actor_id`` is treated as a misconfiguration (HTTP 500) — the
    handler must always know who is acting.
    """
    if actor_id is None or actor_id <= 0:
        raise HTTPException(
            status_code=500,
            detail=(
                f'SoD misconfiguration ({check_name}): '
                f'actor_id is missing or invalid'
            ),
        )
    if not approver_id or approver_id <= 0:
        return
    if approver_id != actor_id:
        return
    if is_super_admin:
        sod_bypass_logged(check_name, approver_id=approver_id, actor_id=actor_id)
        return
    raise HTTPException(
        status_code=403,
        detail=(
            f'Separation of Duties violation ({check_name}): '
            f'this user already acted as approver for this document.'
        ),
    )


def enforce_same_user(
    *,
    expected_user_id: int | None,
    actor_id: int | None,
    check_name: str,
    is_super_admin: bool = False,
) -> None:
    """Block the action unless actor is the expected user (e.g. indent raiser).

    Used at endpoints reserved for the original document owner (e.g.
    Acknowledgement, where only the raiser can confirm receipt).

    A None or non-positive ``actor_id`` or ``expected_user_id`` is treated
    as a misconfiguration (HTTP 500).
    """
    if actor_id is None or actor_id <= 0:
        raise HTTPException(
            status_code=500,
            detail=(
                f'SoD misconfiguration ({check_name}): '
                f'actor_id is missing or invalid'
            ),
        )
    if expected_user_id is None or expected_user_id <= 0:
        raise HTTPException(
            status_code=500,
            detail=(
                f'SoD misconfiguration ({check_name}): '
                f'expected_user_id is missing or invalid'
            ),
        )
    if expected_user_id == actor_id:
        return
    if is_super_admin:
        sod_bypass_logged(check_name,
                          expected_user_id=expected_user_id,
                          actor_id=actor_id)
        return
    raise HTTPException(
        status_code=403,
        detail=(
            f'Restricted to original document owner ({check_name}): '
            f'only user {expected_user_id} may perform this action.'
        ),
    )


def sod_bypass_logged(check_name: str, **kw) -> None:
    """Emit a warning-level log line capturing a super-admin SoD bypass.

    Format (stable): ``sod_bypass check=<name> k1=v1 k2=v2 ...`` (kwargs sorted).
    Downstream audit pipelines should grep for ``sod_bypass`` entries on
    the 'sod' logger to surface bypassed checks for review.

    Recommended kwargs:
        approver_id, actor_id  - for `enforce_different_user` bypasses
        expected_user_id, actor_id  - for `enforce_same_user` bypasses
        document_type, document_id  - what document was being acted on
        actor_username  - readable identity for audit reviewers

    All extra kwargs are formatted into the log line.
    """
    parts = [f'{k}={v}' for k, v in sorted(kw.items())]
    logger.warning('sod_bypass check=%s %s', check_name, ' '.join(parts))
