"""add ERP item packaging hierarchy

Revision ID: z20260515_packaging_hierarchy
Revises: y20260515_vendor_item_history
Create Date: 2026-05-15
"""
from alembic import op
import sqlalchemy as sa


revision = "z20260515_packaging_hierarchy"
down_revision = "y20260515_vendor_item_history"
branch_labels = None
depends_on = None


def _has_column(insp, table_name: str, column_name: str) -> bool:
    return column_name in {c["name"] for c in insp.get_columns(table_name)}


def _has_index(insp, table_name: str, index_name: str) -> bool:
    return index_name in {i["name"] for i in insp.get_indexes(table_name)}


def upgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)

    if not insp.has_table("packaging_levels"):
        op.create_table(
            "packaging_levels",
            sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
            sa.Column("level_name", sa.String(50), nullable=False, unique=True),
            sa.Column("level_order", sa.Integer(), nullable=False),
            sa.Column("is_active", sa.Boolean(), nullable=True, server_default=sa.text("1")),
            sa.Column("created_at", sa.DateTime(), nullable=True, server_default=sa.func.now()),
        )

    columns = (
        ("level_id", sa.Column("level_id", sa.BigInteger(), nullable=True)),
        ("parent_packaging_id", sa.Column("parent_packaging_id", sa.BigInteger(), nullable=True)),
        ("quantity_in_parent", sa.Column("quantity_in_parent", sa.Numeric(15, 4), nullable=True)),
        ("total_base_qty", sa.Column("total_base_qty", sa.Numeric(15, 4), nullable=True)),
        ("sku_code", sa.Column("sku_code", sa.String(100), nullable=True)),
        ("barcode_gtin", sa.Column("barcode_gtin", sa.String(50), nullable=True)),
        ("barcode_sscc", sa.Column("barcode_sscc", sa.String(50), nullable=True)),
        ("length", sa.Column("length", sa.Numeric(10, 4), nullable=True)),
        ("width", sa.Column("width", sa.Numeric(10, 4), nullable=True)),
        ("height", sa.Column("height", sa.Numeric(10, 4), nullable=True)),
        ("dimension_uom_id", sa.Column("dimension_uom_id", sa.BigInteger(), nullable=True)),
        ("gross_weight", sa.Column("gross_weight", sa.Numeric(10, 4), nullable=True)),
        ("tare_weight", sa.Column("tare_weight", sa.Numeric(10, 4), nullable=True)),
        ("weight_uom_id", sa.Column("weight_uom_id", sa.BigInteger(), nullable=True)),
        ("is_active", sa.Column("is_active", sa.Boolean(), nullable=True, server_default=sa.text("1"))),
        ("created_at", sa.Column("created_at", sa.DateTime(), nullable=True, server_default=sa.func.now())),
        ("updated_at", sa.Column("updated_at", sa.DateTime(), nullable=True, server_default=sa.func.now())),
    )
    for name, column in columns:
        if not _has_column(insp, "item_packing", name):
            op.add_column("item_packing", column)

    if not _has_index(insp, "item_packing", "idx_item_packaging_tree"):
        op.create_index("idx_item_packaging_tree", "item_packing", ["item_id", "parent_packaging_id"])

    for name, local_cols, remote_table, remote_cols in (
        ("fk_item_packing_level_id", ["level_id"], "packaging_levels", ["id"]),
        ("fk_item_packing_parent_packaging_id", ["parent_packaging_id"], "item_packing", ["id"]),
        ("fk_item_packing_dimension_uom_id", ["dimension_uom_id"], "uom", ["id"]),
        ("fk_item_packing_weight_uom_id", ["weight_uom_id"], "uom", ["id"]),
    ):
        try:
            op.create_foreign_key(name, "item_packing", remote_table, local_cols, remote_cols)
        except Exception:
            pass

    for constraint_name in ("uq_item_packaging_level", "uq_item_packaging_item_level", "uq_item_packing_item_level"):
        try:
            op.drop_constraint(constraint_name, "item_packing", type_="unique")
        except Exception:
            pass

    for level_name, level_order in (("Pallet", 10), ("Carton", 20), ("Inner Pack", 30), ("Base Unit", 40)):
        op.execute(
            sa.text(
                """
                INSERT INTO packaging_levels (level_name, level_order, is_active, created_at)
                SELECT :level_name, :level_order, 1, CURRENT_TIMESTAMP
                WHERE NOT EXISTS (SELECT 1 FROM packaging_levels WHERE level_name = :level_name)
                """
            ).bindparams(level_name=level_name, level_order=level_order)
        )

    op.execute(
        """
        UPDATE item_packing
        SET level_id = COALESCE(level_id, (SELECT id FROM packaging_levels WHERE level_name = 'Base Unit' LIMIT 1)),
            total_base_qty = COALESCE(total_base_qty, qty_per_pack),
            sku_code = COALESCE(sku_code, packing_name),
            barcode_gtin = COALESCE(barcode_gtin, barcode_value),
            is_active = COALESCE(is_active, 1)
        WHERE level_id IS NULL OR total_base_qty IS NULL
        """
    )


def downgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    for name in (
        "fk_item_packing_weight_uom_id",
        "fk_item_packing_dimension_uom_id",
        "fk_item_packing_parent_packaging_id",
        "fk_item_packing_level_id",
    ):
        try:
            op.drop_constraint(name, "item_packing", type_="foreignkey")
        except Exception:
            pass
    if _has_index(insp, "item_packing", "idx_item_packaging_tree"):
        op.drop_index("idx_item_packaging_tree", table_name="item_packing")
    for name in (
        "updated_at", "created_at", "is_active", "weight_uom_id", "tare_weight", "gross_weight",
        "dimension_uom_id", "height", "width", "length", "barcode_sscc", "barcode_gtin",
        "sku_code", "total_base_qty", "quantity_in_parent", "parent_packaging_id", "level_id",
    ):
        if _has_column(insp, "item_packing", name):
            op.drop_column("item_packing", name)
    if insp.has_table("packaging_levels"):
        op.drop_table("packaging_levels")
