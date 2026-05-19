"""add vendor categories

Revision ID: ab20260516_vendor_categories
Revises: aa20260516_remove_packaging_level_order
Create Date: 2026-05-16
"""
from alembic import op
import sqlalchemy as sa


revision = "ab20260516_vendor_categories"
down_revision = "aa20260516_remove_packaging_level_order"
branch_labels = None
depends_on = None


def _has_column(insp, table_name: str, column_name: str) -> bool:
    return column_name in {c["name"] for c in insp.get_columns(table_name)}


def _has_index(insp, table_name: str, index_name: str) -> bool:
    return index_name in {i["name"] for i in insp.get_indexes(table_name)}


def upgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    if not insp.has_table("vendor_categories"):
        op.create_table(
            "vendor_categories",
            sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
            sa.Column("code", sa.String(50), nullable=False, unique=True),
            sa.Column("name", sa.String(100), nullable=False),
            sa.Column("description", sa.Text(), nullable=True),
            sa.Column("is_active", sa.Boolean(), nullable=True, server_default=sa.text("1")),
            sa.Column("created_at", sa.DateTime(), nullable=True, server_default=sa.func.now()),
            sa.Column("updated_at", sa.DateTime(), nullable=True, server_default=sa.func.now()),
        )

    if insp.has_table("vendors") and not _has_column(insp, "vendors", "vendor_category_id"):
        op.add_column("vendors", sa.Column("vendor_category_id", sa.BigInteger(), nullable=True))
    if insp.has_table("vendors") and not _has_index(insp, "vendors", "ix_vendors_vendor_category_id"):
        op.create_index("ix_vendors_vendor_category_id", "vendors", ["vendor_category_id"])
    try:
        op.create_foreign_key(
            "fk_vendors_vendor_category_id",
            "vendors",
            "vendor_categories",
            ["vendor_category_id"],
            ["id"],
        )
    except Exception:
        pass

    for code, name in (
        ("strategic", "Strategic"),
        ("preferred", "Preferred"),
        ("approved", "Approved"),
        ("conditional", "Conditional"),
        ("blocked", "Blocked"),
    ):
        op.execute(
            sa.text(
                """
                INSERT INTO vendor_categories (code, name, is_active, created_at, updated_at)
                SELECT :code, :name, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
                WHERE NOT EXISTS (SELECT 1 FROM vendor_categories WHERE code = :code)
                """
            ).bindparams(code=code, name=name)
        )


def downgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    try:
        op.drop_constraint("fk_vendors_vendor_category_id", "vendors", type_="foreignkey")
    except Exception:
        pass
    if insp.has_table("vendors") and _has_index(insp, "vendors", "ix_vendors_vendor_category_id"):
        op.drop_index("ix_vendors_vendor_category_id", table_name="vendors")
    if insp.has_table("vendors") and _has_column(insp, "vendors", "vendor_category_id"):
        op.drop_column("vendors", "vendor_category_id")
    if insp.has_table("vendor_categories"):
        op.drop_table("vendor_categories")
