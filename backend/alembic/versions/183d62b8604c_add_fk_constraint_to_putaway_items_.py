"""Add FK constraint to putaway_items batch_id

Revision ID: 183d62b8604c
Revises: 2171986a9c1a
Create Date: 2026-05-09 13:03:39.277859

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '183d62b8604c'
down_revision: Union[str, Sequence[str], None] = '2171986a9c1a'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Add ForeignKey constraint to putaway_items.batch_id."""
    with op.batch_alter_table('putaway_items', schema=None) as batch_op:
        batch_op.create_foreign_key(
            'fk_putaway_items_batch_id',
            'batches',
            ['batch_id'],
            ['id'],
            ondelete='RESTRICT'
        )


def downgrade() -> None:
    """Remove ForeignKey constraint from putaway_items.batch_id."""
    with op.batch_alter_table('putaway_items', schema=None) as batch_op:
        batch_op.drop_constraint('fk_putaway_items_batch_id', type_='foreignkey')
