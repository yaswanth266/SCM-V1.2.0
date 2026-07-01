"""add_project_templates_and_vehicles

Revision ID: 8a1c56d19deb
Revises: 1c85ec8ff435
Create Date: 2026-06-30 17:55:59.236119

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '8a1c56d19deb'
down_revision: Union[str, Sequence[str], None] = '1c85ec8ff435'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    # 1. Create vehicles table
    op.create_table(
        "vehicles",
        sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
        sa.Column("vehicle_code", sa.String(length=50), nullable=False, unique=True),
        sa.Column("vehicle_number", sa.String(length=50), nullable=False, unique=True),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.text("1")),
        sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(), nullable=False, server_default=sa.func.now(), onupdate=sa.func.now()),
    )

    # 2. Create project_indent_templates table
    op.create_table(
        "project_indent_templates",
        sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
        sa.Column("project_id", sa.BigInteger(), sa.ForeignKey("projects.id", ondelete="CASCADE"), nullable=False),
        sa.Column("template_type", sa.String(length=50), nullable=False), # consumables, install
        sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(), nullable=False, server_default=sa.func.now(), onupdate=sa.func.now()),
        sa.UniqueConstraint("project_id", "template_type", name="uq_project_template_type"),
    )

    # 3. Create project_indent_template_items table
    op.create_table(
        "project_indent_template_items",
        sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
        sa.Column("template_id", sa.BigInteger(), sa.ForeignKey("project_indent_templates.id", ondelete="CASCADE"), nullable=False),
        sa.Column("item_id", sa.BigInteger(), sa.ForeignKey("items.id", ondelete="CASCADE"), nullable=False),
        sa.Column("quantity", sa.Numeric(precision=15, scale=3), nullable=False),
        sa.Column("uom_id", sa.BigInteger(), sa.ForeignKey("uom.id", ondelete="SET NULL"), nullable=True),
    )

    # 4. Add vehicle_code and vehicle_number to indents table
    op.add_column("indents", sa.Column("vehicle_code", sa.String(length=50), nullable=True))
    op.add_column("indents", sa.Column("vehicle_number", sa.String(length=50), nullable=True))


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column("indents", "vehicle_number")
    op.drop_column("indents", "vehicle_code")
    op.drop_table("project_indent_template_items")
    op.drop_table("project_indent_templates")
    op.drop_table("vehicles")
