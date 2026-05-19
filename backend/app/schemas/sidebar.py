"""Schemas for /me/sidebar and /me/active-role endpoints.

Created 2026-04-30 as part of the SCM workflow rebuild (Task 6). Revised
2026-05-01: switched from server-rendered nested items to a flat allowed-keys
whitelist so the frontend keeps the existing MENU_CONFIG tree (matches the
look on scm.bhspl.in) and only filters out keys the active role isn't
authorized to see.
"""
from typing import List
from pydantic import BaseModel


class SidebarResponse(BaseModel):
    active_role_id: int
    active_role_code: str
    # Union of MENU_CONFIG keys (top-level and `parent-child`) the active role
    # is allowed to see. Frontend filters its existing menu tree against this.
    allowed_keys: List[str]
