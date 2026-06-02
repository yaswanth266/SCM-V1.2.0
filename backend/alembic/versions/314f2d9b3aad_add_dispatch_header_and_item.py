"""add_dispatch_header_and_item

Revision ID: 314f2d9b3aad
Revises: b1af5101b27c
Create Date: 2026-05-21 10:42:38.342520

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '314f2d9b3aad'
down_revision: Union[str, Sequence[str], None] = 'b1af5101b27c'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table('dispatch_header',
    sa.Column('dispatch_id', sa.String(length=50), nullable=False),
    sa.Column('dispatch_date', sa.Date(), nullable=False),
    sa.Column('status', sa.String(length=50), nullable=False),
    sa.Column('remarks', sa.Text(), nullable=True),
    sa.PrimaryKeyConstraint('dispatch_id')
    )
    op.create_table('dispatch_item',
    sa.Column('id', sa.BigInteger(), autoincrement=True, nullable=False),
    sa.Column('dispatch_id', sa.String(length=50), nullable=False),
    sa.Column('material_id', sa.BigInteger(), nullable=False),
    sa.Column('indent_id', sa.BigInteger(), nullable=True),
    sa.Column('material_issue_id', sa.BigInteger(), nullable=True),
    sa.Column('requested_quantity', sa.Numeric(precision=15, scale=3), nullable=False),
    sa.Column('approved_quantity', sa.Numeric(precision=15, scale=3), nullable=False),
    sa.Column('dispatched_quantity', sa.Numeric(precision=15, scale=3), nullable=False),
    sa.Column('uom', sa.String(length=50), nullable=False),
    sa.Column('request_date', sa.Date(), nullable=False),
    sa.ForeignKeyConstraint(['dispatch_id'], ['dispatch_header.dispatch_id'], ),
    sa.ForeignKeyConstraint(['indent_id'], ['indents.id'], ),
    sa.ForeignKeyConstraint(['material_id'], ['items.id'], ),
    sa.ForeignKeyConstraint(['material_issue_id'], ['material_issues.id'], ),
    sa.PrimaryKeyConstraint('id')
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_table('dispatch_item')
    op.drop_table('dispatch_header')
