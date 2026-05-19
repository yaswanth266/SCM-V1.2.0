"""link item attributes and values to UOM categories

Revision ID: t20260514_item_attribute_uom_categories
Revises: s20260514_uom_categories
Create Date: 2026-05-14
"""
from alembic import op
import sqlalchemy as sa


revision = "t20260514_item_attribute_uom_categories"
down_revision = "s20260514_uom_categories"
branch_labels = None
depends_on = None


def _has_column(inspector, table_name: str, column_name: str) -> bool:
    return column_name in [col["name"] for col in inspector.get_columns(table_name)]


def upgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)

    if not _has_column(insp, "item_attributes", "uom_category_id"):
        op.add_column("item_attributes", sa.Column("uom_category_id", sa.BigInteger(), nullable=True))
        op.create_index("ix_item_attributes_uom_category_id", "item_attributes", ["uom_category_id"])
        op.create_foreign_key(
            "fk_item_attributes_uom_category_id",
            "item_attributes",
            "uom_categories",
            ["uom_category_id"],
            ["id"],
        )

    if not _has_column(insp, "item_attribute_values", "uom_category_id"):
        op.add_column("item_attribute_values", sa.Column("uom_category_id", sa.BigInteger(), nullable=True))
        op.create_index("ix_item_attribute_values_uom_category_id", "item_attribute_values", ["uom_category_id"])
        op.create_foreign_key(
            "fk_item_attribute_values_uom_category_id",
            "item_attribute_values",
            "uom_categories",
            ["uom_category_id"],
            ["id"],
        )

    op.execute(
        """
        UPDATE item_attributes ia
        JOIN uom u ON u.id = ia.uom_id
        SET ia.uom_category_id = u.category_id
        WHERE ia.uom_category_id IS NULL
          AND ia.uom_id IS NOT NULL
          AND u.category_id IS NOT NULL
        """
    )
    op.execute(
        """
        UPDATE item_attribute_values iav
        JOIN uom u ON u.id = iav.uom_id
        SET iav.uom_category_id = u.category_id
        WHERE iav.uom_category_id IS NULL
          AND iav.uom_id IS NOT NULL
          AND u.category_id IS NOT NULL
        """
    )


def downgrade() -> None:
    for table_name, fk_name, ix_name in (
        ("item_attribute_values", "fk_item_attribute_values_uom_category_id", "ix_item_attribute_values_uom_category_id"),
        ("item_attributes", "fk_item_attributes_uom_category_id", "ix_item_attributes_uom_category_id"),
    ):
        try:
            op.drop_constraint(fk_name, table_name, type_="foreignkey")
        except Exception:
            pass
        try:
            op.drop_index(ix_name, table_name=table_name)
        except Exception:
            pass
        try:
            op.drop_column(table_name, "uom_category_id")
        except Exception:
            pass
