"""compatibility marker for existing AW SCM database

Revision ID: 2026_05_28_aw_scm
Revises: 4430e23d028d, add_vendor_users_table
Create Date: 2026-05-28
"""

from typing import Sequence, Union


revision: str = "2026_05_28_aw_scm"
down_revision: Union[str, Sequence[str], None] = (
    "4430e23d028d",
    "add_vendor_users_table",
)
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
