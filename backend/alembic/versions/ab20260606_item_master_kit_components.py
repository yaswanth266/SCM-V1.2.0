"""Add item master kit components

Revision ID: ab20260606_kit_components
Revises: ab20260516_vendor_categories
Create Date: 2026-06-06
"""
from alembic import op
import sqlalchemy as sa


revision = "ab20260606_kit_components"
down_revision = "ab20260516_vendor_categories"
branch_labels = None
depends_on = None


def _has_table(inspector, table_name: str) -> bool:
    return table_name in inspector.get_table_names()


def _has_index(inspector, table_name: str, index_name: str) -> bool:
    if not _has_table(inspector, table_name):
        return False
    return any(idx.get("name") == index_name for idx in inspector.get_indexes(table_name))


def upgrade():
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    op.execute(
        """
        INSERT INTO item_types (name, description, is_active)
        SELECT 'kit', 'Pack or kit item procured and issued as one parent material', 1
        WHERE NOT EXISTS (SELECT 1 FROM item_types WHERE name = 'kit')
        """
    )

    if not _has_table(inspector, "item_master_kit_components"):
        op.create_table(
            "item_master_kit_components",
            sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
            sa.Column("item_id", sa.BigInteger(), nullable=False),
            sa.Column("component_code", sa.String(length=100), nullable=True),
            sa.Column("component_name", sa.String(length=255), nullable=False),
            sa.Column("quantity", sa.Numeric(15, 3), nullable=False),
            sa.Column("uom_id", sa.BigInteger(), nullable=True),
            sa.Column("sort_order", sa.Integer(), nullable=False, server_default="1"),
            sa.Column("remarks", sa.String(length=255), nullable=True),
            sa.Column("created_at", sa.DateTime(), nullable=True),
            sa.Column("updated_at", sa.DateTime(), nullable=True),
            sa.ForeignKeyConstraint(["item_id"], ["items.id"], name="fk_item_master_kit_components_item_id", ondelete="CASCADE"),
            sa.ForeignKeyConstraint(["uom_id"], ["uom.id"], name="fk_item_master_kit_components_uom_id", ondelete="SET NULL"),
        )
        inspector = sa.inspect(bind)

    if not _has_index(inspector, "item_master_kit_components", "ix_item_master_kit_components_item_id"):
        op.create_index("ix_item_master_kit_components_item_id", "item_master_kit_components", ["item_id"])


def downgrade():
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if _has_index(inspector, "item_master_kit_components", "ix_item_master_kit_components_item_id"):
        op.drop_index("ix_item_master_kit_components_item_id", table_name="item_master_kit_components")
    if _has_table(inspector, "item_master_kit_components"):
        op.drop_table("item_master_kit_components")
