"""add vendor users table

Revision ID: add_vendor_users_table
Revises: d9873b09a753
Create Date: 2026-05-27
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "add_vendor_users_table"
down_revision: Union[str, Sequence[str], None] = "d9873b09a753"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    if not inspector.has_table("vendor_users"):
        op.create_table(
            "vendor_users",
            sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
            sa.Column("vendor_id", sa.BigInteger(), nullable=False),
            sa.Column("username", sa.String(length=100), nullable=False),
            sa.Column("email", sa.String(length=255), nullable=False),
            sa.Column("password_hash", sa.String(length=255), nullable=False),
            sa.Column("full_name", sa.String(length=200), nullable=True),
            sa.Column("phone", sa.String(length=20), nullable=True),
            sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.text("1")),
            sa.Column("must_change_password", sa.Boolean(), nullable=False, server_default=sa.text("1")),
            sa.Column("failed_login_attempts", sa.Integer(), nullable=False, server_default=sa.text("0")),
            sa.Column("locked_until", sa.DateTime(), nullable=True),
            sa.Column("last_login", sa.DateTime(), nullable=True),
            sa.Column("password_changed_at", sa.DateTime(), nullable=True),
            sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
            sa.Column("updated_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
            sa.Column("created_by", sa.BigInteger(), nullable=True),
            sa.ForeignKeyConstraint(["created_by"], ["users.id"]),
            sa.ForeignKeyConstraint(["vendor_id"], ["vendors.id"], ondelete="CASCADE"),
            sa.PrimaryKeyConstraint("id"),
        )

    existing_indexes = {idx["name"] for idx in inspector.get_indexes("vendor_users")}
    if "idx_vendor_users_vendor" not in existing_indexes:
        op.create_index("idx_vendor_users_vendor", "vendor_users", ["vendor_id"])
    if "idx_vendor_users_username" not in existing_indexes:
        op.create_index("idx_vendor_users_username", "vendor_users", ["username"], unique=True)

    quotation_item_columns = {col["name"] for col in inspector.get_columns("quotation_items")}
    if "remarks" not in quotation_item_columns:
        op.add_column("quotation_items", sa.Column("remarks", sa.Text(), nullable=True))


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if inspector.has_table("quotation_items"):
        quotation_item_columns = {col["name"] for col in inspector.get_columns("quotation_items")}
        if "remarks" in quotation_item_columns:
            op.drop_column("quotation_items", "remarks")
    if inspector.has_table("vendor_users"):
        op.drop_index("idx_vendor_users_username", table_name="vendor_users")
        op.drop_index("idx_vendor_users_vendor", table_name="vendor_users")
        op.drop_table("vendor_users")
