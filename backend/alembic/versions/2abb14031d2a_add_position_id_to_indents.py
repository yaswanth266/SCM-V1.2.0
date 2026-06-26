"""add_position_id_to_indents

Revision ID: 2abb14031d2a
Revises: c88d9e9b922b
Create Date: 2026-06-26 02:50:26.420609

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '2abb14031d2a'
down_revision: Union[str, Sequence[str], None] = 'c88d9e9b922b'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Add position_id column
    op.add_column('indents', sa.Column('position_id', sa.BigInteger(), nullable=True))
    # Create foreign key constraint
    op.create_foreign_key('fk_indents_position_id', 'indents', 'positions', ['position_id'], ['id'])


def downgrade() -> None:
    # Drop foreign key constraint
    op.drop_constraint('fk_indents_position_id', 'indents', type_='foreignkey')
    # Drop position_id column
    op.drop_column('indents', 'position_id')
