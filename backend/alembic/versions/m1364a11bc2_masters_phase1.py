"""masters phase 1: brands, item attributes, user groups + ownership/generic_name on items

Revision ID: m1364a11bc2
Revises: l1253f10ab1
Create Date: 2026-04-24
"""
from alembic import op
import sqlalchemy as sa


revision = 'm1364a11bc2'
down_revision = 'l1253f10ab1'
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)

    def has_table(name: str) -> bool:
        return insp.has_table(name)

    def has_col(table: str, col: str) -> bool:
        if not has_table(table):
            return False
        return col in [c["name"] for c in insp.get_columns(table)]

    # --- brands ---------------------------------------------------------
    if not has_table("brands"):
        op.create_table(
            "brands",
            sa.Column("id", sa.BigInteger, primary_key=True, autoincrement=True),
            sa.Column("code", sa.String(50), nullable=False, unique=True),
            sa.Column("name", sa.String(255), nullable=False),
            sa.Column("manufacturer_id", sa.BigInteger, nullable=True),
            sa.Column("description", sa.Text, nullable=True),
            sa.Column("is_active", sa.Boolean, server_default=sa.text("1")),
            sa.Column(
                "created_at", sa.DateTime, server_default=sa.text("CURRENT_TIMESTAMP")
            ),
        )

    # --- item_attributes ------------------------------------------------
    # Attribute definitions. Scoped to a category; a laptop category
    # defines Processor/RAM/Storage, a tablet category defines Dosage Form.
    # data_type decides how ItemAttributeValue.value is interpreted.
    if not has_table("item_attributes"):
        op.create_table(
            "item_attributes",
            sa.Column("id", sa.BigInteger, primary_key=True, autoincrement=True),
            sa.Column(
                "category_id",
                sa.BigInteger,
                sa.ForeignKey("item_categories.id"),
                nullable=True,
            ),
            sa.Column("code", sa.String(50), nullable=False),
            sa.Column("name", sa.String(255), nullable=False),
            sa.Column(
                "data_type",
                sa.Enum("text", "number", "boolean", "enum", name="attribute_data_type"),
                nullable=False,
                server_default="text",
            ),
            # UOM only applies to numeric attributes (e.g. RAM in GB).
            sa.Column(
                "uom_id", sa.BigInteger, sa.ForeignKey("uom.id"), nullable=True
            ),
            # For data_type='enum', comma/JSON separated allowed values.
            sa.Column("allowed_values", sa.Text, nullable=True),
            sa.Column("is_required", sa.Boolean, server_default=sa.text("0")),
            sa.Column("sort_order", sa.Integer, server_default="0"),
            sa.Column("is_active", sa.Boolean, server_default=sa.text("1")),
            sa.Column(
                "created_at", sa.DateTime, server_default=sa.text("CURRENT_TIMESTAMP")
            ),
            sa.UniqueConstraint("category_id", "code", name="uq_attr_category_code"),
        )

    # --- item_attribute_values -----------------------------------------
    if not has_table("item_attribute_values"):
        op.create_table(
            "item_attribute_values",
            sa.Column("id", sa.BigInteger, primary_key=True, autoincrement=True),
            sa.Column(
                "item_id",
                sa.BigInteger,
                sa.ForeignKey("items.id", ondelete="CASCADE"),
                nullable=False,
            ),
            sa.Column(
                "attribute_id",
                sa.BigInteger,
                sa.ForeignKey("item_attributes.id", ondelete="CASCADE"),
                nullable=False,
            ),
            sa.Column("value", sa.String(500), nullable=True),
            # Stored UOM snapshot — if the attribute's UOM later changes,
            # historical values still carry the UOM that was used.
            sa.Column(
                "uom_id", sa.BigInteger, sa.ForeignKey("uom.id"), nullable=True
            ),
            sa.Column(
                "created_at", sa.DateTime, server_default=sa.text("CURRENT_TIMESTAMP")
            ),
            sa.UniqueConstraint("item_id", "attribute_id", name="uq_iav_item_attr"),
        )

    # --- user_groups ---------------------------------------------------
    if not has_table("user_groups"):
        op.create_table(
            "user_groups",
            sa.Column("id", sa.BigInteger, primary_key=True, autoincrement=True),
            sa.Column("code", sa.String(50), nullable=False, unique=True),
            sa.Column("name", sa.String(255), nullable=False),
            sa.Column("description", sa.Text, nullable=True),
            sa.Column("is_active", sa.Boolean, server_default=sa.text("1")),
            sa.Column(
                "created_at", sa.DateTime, server_default=sa.text("CURRENT_TIMESTAMP")
            ),
        )

    if not has_table("user_group_members"):
        op.create_table(
            "user_group_members",
            sa.Column("id", sa.BigInteger, primary_key=True, autoincrement=True),
            sa.Column(
                "group_id",
                sa.BigInteger,
                sa.ForeignKey("user_groups.id", ondelete="CASCADE"),
                nullable=False,
            ),
            sa.Column(
                "user_id",
                sa.BigInteger,
                sa.ForeignKey("users.id", ondelete="CASCADE"),
                nullable=False,
            ),
            sa.Column(
                "added_at", sa.DateTime, server_default=sa.text("CURRENT_TIMESTAMP")
            ),
            sa.UniqueConstraint("group_id", "user_id", name="uq_ugm_group_user"),
        )

    # Mapping between a user group and what it's allowed to do:
    # Which item categories / items / UOMs / indent types it can use.
    if not has_table("user_group_permissions"):
        op.create_table(
            "user_group_permissions",
            sa.Column("id", sa.BigInteger, primary_key=True, autoincrement=True),
            sa.Column(
                "group_id",
                sa.BigInteger,
                sa.ForeignKey("user_groups.id", ondelete="CASCADE"),
                nullable=False,
            ),
            sa.Column("entity_type", sa.String(50), nullable=False),
            sa.Column("entity_id", sa.BigInteger, nullable=True),
            sa.Column("action", sa.String(50), nullable=False, server_default="view"),
            sa.Column(
                "created_at", sa.DateTime, server_default=sa.text("CURRENT_TIMESTAMP")
            ),
            sa.UniqueConstraint(
                "group_id", "entity_type", "entity_id", "action",
                name="uq_ugp_group_entity_action",
            ),
            sa.Index("ix_ugp_entity", "entity_type", "entity_id"),
        )

    # --- items column additions ----------------------------------------
    if not has_col("items", "generic_name"):
        op.add_column("items", sa.Column("generic_name", sa.String(255), nullable=True))
    if not has_col("items", "ownership"):
        op.add_column(
            "items",
            sa.Column(
                "ownership",
                sa.Enum("IT", "HR", "OP", "ADM", "FA", "FL", name="item_ownership"),
                nullable=True,
            ),
        )
    if not has_col("items", "marketer"):
        op.add_column("items", sa.Column("marketer", sa.String(255), nullable=True))
    if not has_col("items", "distributor"):
        op.add_column("items", sa.Column("distributor", sa.String(255), nullable=True))

    # Add 'spare' and 'semi_finished_goods' to items.item_type enum.
    # MySQL: MODIFY COLUMN with new enum listing.
    op.execute(
        """
        ALTER TABLE items MODIFY COLUMN item_type
        ENUM('traded','consumable','finished_goods','raw_material','medicine','asset','spare','semi_finished_goods')
        NOT NULL
        """
    )


def downgrade() -> None:
    # Reverse order.
    op.execute(
        """
        ALTER TABLE items MODIFY COLUMN item_type
        ENUM('traded','consumable','finished_goods','raw_material','medicine','asset')
        NOT NULL
        """
    )
    for col in ("distributor", "marketer", "ownership", "generic_name"):
        try:
            op.drop_column("items", col)
        except Exception:
            pass
    for tbl in (
        "user_group_permissions",
        "user_group_members",
        "user_groups",
        "item_attribute_values",
        "item_attributes",
        "brands",
    ):
        try:
            op.drop_table(tbl)
        except Exception:
            pass
