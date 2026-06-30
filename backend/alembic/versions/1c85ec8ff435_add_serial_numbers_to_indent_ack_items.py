"""add_serial_numbers_to_indent_ack_items

Revision ID: 1c85ec8ff435
Revises: 2abb14031d2a
Create Date: 2026-06-29 17:50:11.442014

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '1c85ec8ff435'
down_revision: Union[str, Sequence[str], None] = '2abb14031d2a'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    if inspector.has_table("indent_acknowledgement_items"):
        columns = [c["name"] for c in inspector.get_columns("indent_acknowledgement_items")]
        if "serial_numbers" not in columns:
            op.add_column("indent_acknowledgement_items", sa.Column("serial_numbers", sa.JSON(), nullable=True))


def downgrade() -> None:
    """Downgrade schema."""
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    if inspector.has_table("indent_acknowledgement_items"):
        columns = [c["name"] for c in inspector.get_columns("indent_acknowledgement_items")]
        if "serial_numbers" in columns:
            op.drop_column("indent_acknowledgement_items", "serial_numbers")
