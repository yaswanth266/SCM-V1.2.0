"""Add item_types table and migrate items.item_type from enum to FK

Revision ID: r2026_item_types
Revises: fix_item_fields
Create Date: 2026-05-13
"""
from alembic import op
import sqlalchemy as sa

revision = "r2026_item_types"
down_revision = None
branch_labels = None
depends_on = None

# Seed values — the old enum values that must exist in item_types
SEED_TYPES = [
    ("traded", "Traded goods"),
    ("consumable", "Consumable items"),
    ("finished_goods", "Finished goods"),
    ("raw_material", "Raw materials"),
    ("medicine", "Medicine / pharmaceutical"),
    ("asset", "Fixed or movable asset"),
    ("spare", "Spare parts"),
    ("semi_finished_goods", "Semi-finished goods"),
]


def upgrade() -> None:
    # 1. Create the item_types table
    op.create_table(
        "item_types",
        sa.Column("id", sa.BigInteger, primary_key=True, autoincrement=True),
        sa.Column("name", sa.String(100), unique=True, nullable=False),
        sa.Column("description", sa.Text),
        sa.Column("is_active", sa.Boolean, default=True),
        sa.Column("created_at", sa.DateTime, server_default=sa.func.now()),
    )

    # 2. Seed the table with existing enum values
    item_types_table = sa.table(
        "item_types",
        sa.column("name", sa.String),
        sa.column("description", sa.Text),
        sa.column("is_active", sa.Boolean),
    )
    op.bulk_insert(item_types_table, [
        {"name": name, "description": desc, "is_active": True}
        for name, desc in SEED_TYPES
    ])

    # 3. Alter items.item_type column from ENUM to VARCHAR(100)
    #    MySQL requires dropping the column and re-adding it, or using MODIFY.
    #    Using raw SQL for safety with MySQL enum-to-varchar conversion.
    op.execute("ALTER TABLE items MODIFY COLUMN item_type VARCHAR(100) NOT NULL")

    # 4. Add FK constraint from items.item_type -> item_types.name
    op.create_foreign_key(
        "fk_items_item_type",
        "items",
        "item_types",
        ["item_type"],
        ["name"],
    )


def downgrade() -> None:
    # Remove FK
    op.drop_constraint("fk_items_item_type", "items", type_="foreignkey")

    # Convert back to ENUM (with the original values)
    enum_values = "','".join([t[0] for t in SEED_TYPES])
    op.execute(
        f"ALTER TABLE items MODIFY COLUMN item_type ENUM('{enum_values}') NOT NULL"
    )

    # Drop table
    op.drop_table("item_types")
