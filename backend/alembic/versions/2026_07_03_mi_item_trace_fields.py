"""Add batch_number_text and bin_code_text to material_issue_items
for non-central warehouse traceability.

Revision ID: 2026_07_03_mi_item_trace_fields
Revises: 2026_07_03_schema_drift_sync
Create Date: 2026-07-03
"""

from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa

revision: str = "2026_07_03_mi_item_trace_fields"
down_revision: Union[str, Sequence[str], None] = "2026_07_03_schema_drift_sync"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _has_column(inspector, table_name: str, column_name: str) -> bool:
    try:
        return any(col["name"] == column_name for col in inspector.get_columns(table_name))
    except Exception:
        return False


def upgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)

    # Add batch_number_text — free-text source batch reference for non-central warehouses
    if not _has_column(insp, "material_issue_items", "batch_number_text"):
        op.add_column(
            "material_issue_items",
            sa.Column(
                "batch_number_text",
                sa.String(length=100),
                nullable=True,
                comment="Free-text source batch reference for non-central WH (no FK, no ledger validation)",
            ),
        )

    # Add bin_code_text — free-text source location reference for non-central warehouses
    if not _has_column(insp, "material_issue_items", "bin_code_text"):
        op.add_column(
            "material_issue_items",
            sa.Column(
                "bin_code_text",
                sa.String(length=100),
                nullable=True,
                comment="Free-text source bin/location reference for non-central WH",
            ),
        )


def downgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)

    if _has_column(insp, "material_issue_items", "bin_code_text"):
        op.drop_column("material_issue_items", "bin_code_text")

    if _has_column(insp, "material_issue_items", "batch_number_text"):
        op.drop_column("material_issue_items", "batch_number_text")
