"""add missing schema drift fixes

Revision ID: 2026_06_01_schema_drift_fixes
Revises: 2026_05_28_aw_scm
Create Date: 2026-06-01
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "2026_06_01_schema_drift_fixes"
down_revision: Union[str, Sequence[str], None] = "2026_05_28_aw_scm"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _has_table(inspector, table_name: str) -> bool:
    return table_name in inspector.get_table_names()


def _has_column(inspector, table_name: str, column_name: str) -> bool:
    if not _has_table(inspector, table_name):
        return False
    return any(col["name"] == column_name for col in inspector.get_columns(table_name))


def _has_constraint(inspector, table_name: str, constraint_name: str) -> bool:
    constraints = inspector.get_unique_constraints(table_name)
    constraints += inspector.get_foreign_keys(table_name)
    return any(constraint.get("name") == constraint_name for constraint in constraints)


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    if not _has_table(inspector, "role_item_permissions"):
        op.create_table(
            "role_item_permissions",
            sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
            sa.Column("role_id", sa.BigInteger(), nullable=False),
            sa.Column("entity_type", sa.String(length=50), nullable=False),
            sa.Column("entity_id", sa.BigInteger(), nullable=True),
            sa.Column("action", sa.String(length=50), nullable=False, server_default="view"),
            sa.Column("created_at", sa.DateTime(), nullable=True),
            sa.ForeignKeyConstraint(["role_id"], ["roles.id"], name="fk_role_item_permissions_role_id_roles", ondelete="CASCADE"),
            sa.PrimaryKeyConstraint("id"),
            sa.UniqueConstraint("role_id", "entity_type", "entity_id", "action", name="uq_role_item_permissions_scope"),
        )
    elif not _has_constraint(inspector, "role_item_permissions", "uq_role_item_permissions_scope"):
        op.create_unique_constraint(
            "uq_role_item_permissions_scope",
            "role_item_permissions",
            ["role_id", "entity_type", "entity_id", "action"],
        )

    inspector = sa.inspect(bind)
    if _has_table(inspector, "warehouses") and not _has_column(inspector, "warehouses", "parent_id"):
        op.add_column("warehouses", sa.Column("parent_id", sa.BigInteger(), nullable=True))
        op.create_foreign_key(
            "fk_warehouses_parent_id_warehouses",
            "warehouses",
            "warehouses",
            ["parent_id"],
            ["id"],
        )

    inspector = sa.inspect(bind)
    if _has_table(inspector, "purchase_orders") and not _has_column(inspector, "purchase_orders", "supplier_acknowledgement"):
        op.add_column(
            "purchase_orders",
            sa.Column("supplier_acknowledgement", sa.String(length=50), nullable=False, server_default="pending"),
        )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    if _has_table(inspector, "purchase_orders") and _has_column(inspector, "purchase_orders", "supplier_acknowledgement"):
        op.drop_column("purchase_orders", "supplier_acknowledgement")

    inspector = sa.inspect(bind)
    if _has_table(inspector, "warehouses") and _has_column(inspector, "warehouses", "parent_id"):
        if _has_constraint(inspector, "warehouses", "fk_warehouses_parent_id_warehouses"):
            op.drop_constraint("fk_warehouses_parent_id_warehouses", "warehouses", type_="foreignkey")
        op.drop_column("warehouses", "parent_id")

    if _has_table(inspector, "role_item_permissions"):
        op.drop_table("role_item_permissions")
