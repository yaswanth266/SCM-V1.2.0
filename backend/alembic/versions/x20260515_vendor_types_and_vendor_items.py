"""add vendor type master and vendor mappings

Revision ID: x20260515_vendor_types
Revises: w20260515_enterprise_uom
Create Date: 2026-05-15
"""
from alembic import op
import sqlalchemy as sa


revision = "x20260515_vendor_types"
down_revision = "w20260515_enterprise_uom"
branch_labels = None
depends_on = None


def _has_column(inspector, table_name: str, column_name: str) -> bool:
    return column_name in {col["name"] for col in inspector.get_columns(table_name)}


def upgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)

    if not insp.has_table("vendor_types"):
        op.create_table(
            "vendor_types",
            sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
            sa.Column("code", sa.String(50), nullable=False, unique=True),
            sa.Column("name", sa.String(100), nullable=False),
            sa.Column("description", sa.Text(), nullable=True),
            sa.Column("is_active", sa.Boolean(), nullable=True, server_default=sa.text("1")),
            sa.Column("created_at", sa.DateTime(), nullable=True, server_default=sa.func.now()),
            sa.Column("updated_at", sa.DateTime(), nullable=True, server_default=sa.func.now()),
        )

    if not _has_column(insp, "vendors", "vendor_type_id"):
        op.add_column("vendors", sa.Column("vendor_type_id", sa.BigInteger(), nullable=True))
        op.create_index("ix_vendors_vendor_type_id", "vendors", ["vendor_type_id"])
        op.create_foreign_key("fk_vendors_vendor_type_id", "vendors", "vendor_types", ["vendor_type_id"], ["id"])

    if not insp.has_table("vendor_vendor_types"):
        op.create_table(
            "vendor_vendor_types",
            sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
            sa.Column("vendor_id", sa.BigInteger(), nullable=False),
            sa.Column("vendor_type_id", sa.BigInteger(), nullable=False),
            sa.Column("created_at", sa.DateTime(), nullable=True, server_default=sa.func.now()),
            sa.ForeignKeyConstraint(["vendor_id"], ["vendors.id"], ondelete="CASCADE"),
            sa.ForeignKeyConstraint(["vendor_type_id"], ["vendor_types.id"]),
            sa.UniqueConstraint("vendor_id", "vendor_type_id", name="uq_vendor_vendor_type"),
        )

    op.execute(
        """
        INSERT INTO vendor_types (code, name, is_active, created_at)
        SELECT 'material', 'Material Supplier', 1, CURRENT_TIMESTAMP
        WHERE NOT EXISTS (SELECT 1 FROM vendor_types WHERE code = 'material')
        """
    )
    op.execute(
        """
        INSERT INTO vendor_types (code, name, is_active, created_at)
        SELECT 'transport', 'Transport Vendor', 1, CURRENT_TIMESTAMP
        WHERE NOT EXISTS (SELECT 1 FROM vendor_types WHERE code = 'transport')
        """
    )
    op.execute(
        """
        INSERT INTO vendor_types (code, name, is_active, created_at)
        SELECT 'service', 'Service Provider', 1, CURRENT_TIMESTAMP
        WHERE NOT EXISTS (SELECT 1 FROM vendor_types WHERE code = 'service')
        """
    )
    op.execute(
        """
        INSERT INTO vendor_types (code, name, is_active, created_at)
        SELECT 'both', 'Material & Service', 1, CURRENT_TIMESTAMP
        WHERE NOT EXISTS (SELECT 1 FROM vendor_types WHERE code = 'both')
        """
    )
    op.execute(
        """
        UPDATE vendors v
        JOIN vendor_types vt
          ON vt.code COLLATE utf8mb4_unicode_ci = v.vendor_type COLLATE utf8mb4_unicode_ci
        SET v.vendor_type_id = vt.id
        WHERE v.vendor_type_id IS NULL
        """
    )
    op.execute(
        """
        INSERT IGNORE INTO vendor_vendor_types (vendor_id, vendor_type_id, created_at)
        SELECT id, vendor_type_id, CURRENT_TIMESTAMP
        FROM vendors
        WHERE vendor_type_id IS NOT NULL
        """
    )

    try:
        op.create_unique_constraint("uq_vendor_item", "vendor_items", ["vendor_id", "item_id"])
    except Exception:
        pass


def downgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    try:
        op.drop_constraint("uq_vendor_item", "vendor_items", type_="unique")
    except Exception:
        pass
    if insp.has_table("vendor_vendor_types"):
        op.drop_table("vendor_vendor_types")
    if _has_column(insp, "vendors", "vendor_type_id"):
        op.drop_constraint("fk_vendors_vendor_type_id", "vendors", type_="foreignkey")
        op.drop_index("ix_vendors_vendor_type_id", table_name="vendors")
        op.drop_column("vendors", "vendor_type_id")
    if insp.has_table("vendor_types"):
        op.drop_table("vendor_types")
