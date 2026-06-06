"""Add item is_kit flag

Revision ID: ab20260606_item_is_kit
Revises: ab20260606_kit_components
Create Date: 2026-06-06
"""
from alembic import op
import sqlalchemy as sa


revision = "ab20260606_item_is_kit"
down_revision = "ab20260606_kit_components"
branch_labels = None
depends_on = None


def _has_column(inspector, table_name: str, column_name: str) -> bool:
    return any(col.get("name") == column_name for col in inspector.get_columns(table_name))


def upgrade():
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    if not _has_column(inspector, "items", "is_kit"):
        op.add_column("items", sa.Column("is_kit", sa.Boolean(), nullable=False, server_default=sa.text("0")))

    op.execute(
        """
        UPDATE items i
        SET i.is_kit = 1
        WHERE LOWER(TRIM(COALESCE(i.item_type, ''))) IN ('kit', 'pack', 'kit_pack', 'kit/pack')
           OR EXISTS (
                SELECT 1
                FROM item_master_kit_components c
                WHERE c.item_id = i.id
           )
        """
    )


def downgrade():
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if _has_column(inspector, "items", "is_kit"):
        op.drop_column("items", "is_kit")
