"""add warehouse configs table

Revision ID: c88d9e9b922b
Revises: a5a1e0f6680e
Create Date: 2026-06-26 01:23:16.763045

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'c88d9e9b922b'
down_revision: Union[str, Sequence[str], None] = 'a5a1e0f6680e'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table('warehouse_configs',
        sa.Column('id', sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column('warehouse_id', sa.BigInteger(), nullable=False),
        sa.Column('is_central', sa.Boolean(), nullable=True, default=False),
        sa.ForeignKeyConstraint(['warehouse_id'], ['warehouses.id'], ),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('warehouse_id')
    )


def downgrade() -> None:
    op.drop_table('warehouse_configs')
