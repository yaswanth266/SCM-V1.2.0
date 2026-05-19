"""demand pool: mr_indent_links to support many indents -> one MR

Revision ID: n1475b12cd3
Revises: m1364a11bc2
Create Date: 2026-04-25
"""
from alembic import op
import sqlalchemy as sa


revision = 'n1475b12cd3'
down_revision = 'm1364a11bc2'
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)

    if not insp.has_table("mr_indent_links"):
        op.create_table(
            "mr_indent_links",
            sa.Column("id", sa.BigInteger, primary_key=True, autoincrement=True),
            sa.Column(
                "mr_id",
                sa.BigInteger,
                sa.ForeignKey("material_requests.id", ondelete="CASCADE"),
                nullable=False,
            ),
            sa.Column(
                "indent_id",
                sa.BigInteger,
                sa.ForeignKey("indents.id"),
                nullable=False,
            ),
            sa.Column(
                "indent_item_id",
                sa.BigInteger,
                sa.ForeignKey("indent_items.id"),
                nullable=True,
            ),
            sa.Column(
                "mr_item_id",
                sa.BigInteger,
                sa.ForeignKey("material_request_items.id"),
                nullable=True,
            ),
            sa.Column("qty", sa.Numeric(15, 3), nullable=False, server_default="0"),
            sa.Column(
                "created_at", sa.DateTime, server_default=sa.text("CURRENT_TIMESTAMP")
            ),
            # No unique on indent_id alone — an indent's items go to one MR but
            # the row count = item rows, not indent count.
            sa.UniqueConstraint("mr_id", "indent_item_id", name="uq_mril_mr_indent_item"),
            sa.Index("ix_mril_indent", "indent_id"),
            sa.Index("ix_mril_mr", "mr_id"),
        )


def downgrade() -> None:
    try:
        op.drop_table("mr_indent_links")
    except Exception:
        pass
