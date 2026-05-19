"""upgrade UOM conversions for enterprise ERP behavior

Revision ID: w20260515_enterprise_uom
Revises: v20260514_item_category_codes
Create Date: 2026-05-15
"""
from alembic import op
import sqlalchemy as sa


revision = "w20260515_enterprise_uom"
down_revision = "v20260514_item_category_codes"
branch_labels = None
depends_on = None


def _has_column(inspector, table_name: str, column_name: str) -> bool:
    return column_name in {col["name"] for col in inspector.get_columns(table_name)}


def _has_table(inspector, table_name: str) -> bool:
    return inspector.has_table(table_name)


def upgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)

    if not _has_column(insp, "uom_categories", "base_uom_id"):
        op.add_column("uom_categories", sa.Column("base_uom_id", sa.BigInteger(), nullable=True))
        op.create_index("ix_uom_categories_base_uom_id", "uom_categories", ["base_uom_id"])
        op.create_foreign_key("fk_uom_categories_base_uom_id", "uom_categories", "uom", ["base_uom_id"], ["id"])

    for table_name in ("uom_categories", "uom"):
        if not _has_column(insp, table_name, "updated_at"):
            op.add_column(table_name, sa.Column("updated_at", sa.DateTime(), nullable=True, server_default=sa.func.now()))

    columns = {col["name"] for col in insp.get_columns("uom_conversions")}
    additions = [
        ("category_id", sa.Column("category_id", sa.BigInteger(), nullable=True)),
        ("factor_num", sa.Column("factor_num", sa.Numeric(24, 12), nullable=False, server_default="1")),
        ("factor_den", sa.Column("factor_den", sa.Numeric(24, 12), nullable=False, server_default="1")),
        ("valid_from", sa.Column("valid_from", sa.DateTime(), nullable=False, server_default=sa.func.now())),
        ("valid_to", sa.Column("valid_to", sa.DateTime(), nullable=True)),
        ("is_system", sa.Column("is_system", sa.Boolean(), nullable=True, server_default=sa.text("0"))),
        ("created_at", sa.Column("created_at", sa.DateTime(), nullable=True, server_default=sa.func.now())),
        ("updated_at", sa.Column("updated_at", sa.DateTime(), nullable=True, server_default=sa.func.now())),
    ]
    for column_name, column in additions:
        if column_name not in columns:
            op.add_column("uom_conversions", column)

    op.execute(
        """
        UPDATE uom_conversions uc
        JOIN uom u ON u.id = uc.from_uom_id
        SET uc.category_id = u.category_id
        WHERE uc.category_id IS NULL
        """
    )
    op.execute(
        """
        UPDATE uom_conversions
        SET factor_num = conversion_factor, factor_den = 1
        WHERE factor_num = 1 AND factor_den = 1 AND conversion_factor <> 1
        """
    )

    if not _has_table(insp, "item_uom_conversions"):
        op.create_table(
            "item_uom_conversions",
            sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
            sa.Column("item_id", sa.BigInteger(), nullable=False),
            sa.Column("from_uom_id", sa.BigInteger(), nullable=False),
            sa.Column("to_uom_id", sa.BigInteger(), nullable=False),
            sa.Column("conversion_type", sa.String(50), nullable=True),
            sa.Column("factor_num", sa.Numeric(24, 12), nullable=False, server_default="1"),
            sa.Column("factor_den", sa.Numeric(24, 12), nullable=False, server_default="1"),
            sa.Column("conversion_factor", sa.Numeric(24, 12), nullable=False),
            sa.Column("valid_from", sa.DateTime(), nullable=False, server_default=sa.func.now()),
            sa.Column("valid_to", sa.DateTime(), nullable=True),
            sa.Column("is_active", sa.Boolean(), nullable=True, server_default=sa.text("1")),
            sa.Column("created_at", sa.DateTime(), nullable=True, server_default=sa.func.now()),
            sa.Column("updated_at", sa.DateTime(), nullable=True, server_default=sa.func.now()),
            sa.ForeignKeyConstraint(["item_id"], ["items.id"]),
            sa.ForeignKeyConstraint(["from_uom_id"], ["uom.id"]),
            sa.ForeignKeyConstraint(["to_uom_id"], ["uom.id"]),
        )


def downgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    if _has_table(insp, "item_uom_conversions"):
        op.drop_table("item_uom_conversions")

    for column_name in ("updated_at", "created_at", "is_system", "valid_to", "valid_from", "factor_den", "factor_num", "category_id"):
        if _has_column(insp, "uom_conversions", column_name):
            op.drop_column("uom_conversions", column_name)

    for table_name in ("uom", "uom_categories"):
        if _has_column(insp, table_name, "updated_at"):
            op.drop_column(table_name, "updated_at")

    if _has_column(insp, "uom_categories", "base_uom_id"):
        op.drop_constraint("fk_uom_categories_base_uom_id", "uom_categories", type_="foreignkey")
        op.drop_index("ix_uom_categories_base_uom_id", table_name="uom_categories")
        op.drop_column("uom_categories", "base_uom_id")
