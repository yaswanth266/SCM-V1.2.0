"""Add role_id to user_warehouses for role-warehouse mapping

Revision ID: ab20260616_uw_role
Revises: ab20260606_read_codes
Create Date: 2026-06-16
"""
from alembic import op
import sqlalchemy as sa


revision = "ab20260616_uw_role"
down_revision = ("ab20260606_read_codes", "17dc0cd2dd9a")
branch_labels = None
depends_on = None


def _has_column(inspector, table_name: str, column_name: str) -> bool:
    return any(col.get("name") == column_name for col in inspector.get_columns(table_name))


def _has_constraint(inspector, table_name: str, constraint_name: str) -> bool:
    try:
        fks = inspector.get_foreign_keys(table_name)
        return any(fk.get("name") == constraint_name for fk in fks)
    except Exception:
        return False


def upgrade():
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    # Add role_id column to user_warehouses (nullable — existing rows keep working)
    if not _has_column(inspector, "user_warehouses", "role_id"):
        op.add_column(
            "user_warehouses",
            sa.Column("role_id", sa.BigInteger(), nullable=True),
        )

    # Add FK: user_warehouses.role_id -> roles.id
    inspector = sa.inspect(bind)
    if not _has_constraint(inspector, "user_warehouses", "fk_uw_role_id"):
        try:
            op.create_foreign_key(
                "fk_uw_role_id",
                "user_warehouses",
                "roles",
                ["role_id"],
                ["id"],
                ondelete="SET NULL",
            )
        except Exception:
            pass  # FK may already exist or roles table not reachable


def downgrade():
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    if _has_constraint(inspector, "user_warehouses", "fk_uw_role_id"):
        try:
            op.drop_constraint("fk_uw_role_id", "user_warehouses", type_="foreignkey")
        except Exception:
            pass

    if _has_column(inspector, "user_warehouses", "role_id"):
        op.drop_column("user_warehouses", "role_id")
