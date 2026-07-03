"""add UOM categories

Revision ID: s20260514_uom_categories
Revises: r2026_item_types
Create Date: 2026-05-14
"""
from alembic import op
import sqlalchemy as sa


revision = "s20260514_uom_categories"
down_revision = "r2026_item_types"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)

    if not insp.has_table("uom_categories"):
        op.create_table(
            "uom_categories",
            sa.Column("id", sa.BigInteger, primary_key=True, autoincrement=True),
            sa.Column("name", sa.String(100), nullable=False, unique=True),
            sa.Column("description", sa.Text(), nullable=True),
            sa.Column("is_active", sa.Boolean(), nullable=True, server_default=sa.text("1")),
            sa.Column("created_at", sa.DateTime(), nullable=True, server_default=sa.func.now()),
        )

    if insp.has_table("uom"):
        columns = [c["name"] for c in insp.get_columns("uom")]
        if "category_id" not in columns:
            op.add_column("uom", sa.Column("category_id", sa.BigInteger(), nullable=True))

        indexes = [i["name"] for i in insp.get_indexes("uom")]
        if "ix_uom_category_id" not in indexes:
            op.create_index("ix_uom_category_id", "uom", ["category_id"])

        fks = [fk["name"] for fk in insp.get_foreign_keys("uom")]
        if "fk_uom_category_id" not in fks:
            op.create_foreign_key(
                "fk_uom_category_id",
                "uom",
                "uom_categories",
                ["category_id"],
                ["id"],
            )


def downgrade() -> None:
    op.drop_constraint("fk_uom_category_id", "uom", type_="foreignkey")
    op.drop_index("ix_uom_category_id", table_name="uom")
    op.drop_column("uom", "category_id")
    op.drop_table("uom_categories")
