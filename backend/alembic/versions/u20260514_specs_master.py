"""add specs master tables

Revision ID: u20260514_specs_master
Revises: t20260514_item_attribute_uom_categories
Create Date: 2026-05-14
"""
from alembic import op
import sqlalchemy as sa


revision = "u20260514_specs_master"
down_revision = "t20260514_item_attribute_uom_categories"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)

    if not insp.has_table("spec_categories"):
        op.create_table(
            "spec_categories",
            sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
            sa.Column("code", sa.String(30), nullable=False, unique=True),
            sa.Column("name", sa.String(100), nullable=False),
            sa.Column("description", sa.Text(), nullable=True),
            sa.Column("base_uom_id", sa.BigInteger(), nullable=True),
            sa.Column("sort_order", sa.Integer(), nullable=True, server_default="0"),
            sa.Column("is_active", sa.Boolean(), nullable=True, server_default=sa.text("1")),
            sa.Column("created_at", sa.DateTime(), nullable=True, server_default=sa.func.now()),
            sa.ForeignKeyConstraint(["base_uom_id"], ["uom.id"]),
        )

    if not insp.has_table("specs"):
        op.create_table(
            "specs",
            sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
            sa.Column("category_id", sa.BigInteger(), nullable=False),
            sa.Column("code", sa.String(50), nullable=False, unique=True),
            sa.Column("name", sa.String(100), nullable=False),
            sa.Column("data_type", sa.Enum("text", "number", "boolean", "enum", "range", name="spec_data_type"), nullable=False),
            sa.Column("uom_id", sa.BigInteger(), nullable=True),
            sa.Column("uom_category_id", sa.BigInteger(), nullable=True),
            sa.Column("allowed_values", sa.Text(), nullable=True),
            sa.Column("is_required", sa.Boolean(), nullable=True, server_default=sa.text("0")),
            sa.Column("sort_order", sa.Integer(), nullable=True, server_default="0"),
            sa.Column("is_active", sa.Boolean(), nullable=True, server_default=sa.text("1")),
            sa.Column("created_at", sa.DateTime(), nullable=True, server_default=sa.func.now()),
            sa.ForeignKeyConstraint(["category_id"], ["spec_categories.id"]),
            sa.ForeignKeyConstraint(["uom_id"], ["uom.id"]),
            sa.ForeignKeyConstraint(["uom_category_id"], ["uom_categories.id"]),
        )

    if not insp.has_table("item_specs"):
        op.create_table(
            "item_specs",
            sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
            sa.Column("item_category_id", sa.BigInteger(), nullable=False),
            sa.Column("spec_id", sa.BigInteger(), nullable=False),
            sa.Column("default_value", sa.String(500), nullable=True),
            sa.Column("uom_id", sa.BigInteger(), nullable=True),
            sa.Column("is_required", sa.Boolean(), nullable=True, server_default=sa.text("0")),
            sa.Column("sort_order", sa.Integer(), nullable=True, server_default="0"),
            sa.Column("is_active", sa.Boolean(), nullable=True, server_default=sa.text("1")),
            sa.Column("created_at", sa.DateTime(), nullable=True, server_default=sa.func.now()),
            sa.ForeignKeyConstraint(["item_category_id"], ["item_categories.id"]),
            sa.ForeignKeyConstraint(["spec_id"], ["specs.id"]),
            sa.ForeignKeyConstraint(["uom_id"], ["uom.id"]),
            sa.UniqueConstraint("item_category_id", "spec_id", name="uq_item_category_spec"),
        )

    if not insp.has_table("item_spec_values"):
        op.create_table(
            "item_spec_values",
            sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
            sa.Column("item_id", sa.BigInteger(), nullable=False),
            sa.Column("spec_id", sa.BigInteger(), nullable=False),
            sa.Column("value", sa.String(500), nullable=True),
            sa.Column("min_value", sa.String(100), nullable=True),
            sa.Column("max_value", sa.String(100), nullable=True),
            sa.Column("uom_id", sa.BigInteger(), nullable=True),
            sa.Column("created_at", sa.DateTime(), nullable=True, server_default=sa.func.now()),
            sa.ForeignKeyConstraint(["item_id"], ["items.id"]),
            sa.ForeignKeyConstraint(["spec_id"], ["specs.id"]),
            sa.ForeignKeyConstraint(["uom_id"], ["uom.id"]),
            sa.UniqueConstraint("item_id", "spec_id", name="uq_item_spec"),
        )


def downgrade() -> None:
    for table_name in ("item_spec_values", "item_specs", "specs", "spec_categories"):
        try:
            op.drop_table(table_name)
        except Exception:
            pass
