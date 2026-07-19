"""add_requires_quality_inspection_to_items

Revision ID: e5970e8dc9f3
Revises: 4274b7f69a1b
Create Date: 2026-07-18 18:42:29.384863

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = 'e5970e8dc9f3'
down_revision: Union[str, Sequence[str], None] = '4274b7f69a1b'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # 1. Add requires_quality_inspection to items
    with op.batch_alter_table('items', schema=None) as batch_op:
        batch_op.add_column(sa.Column('requires_quality_inspection', sa.Boolean(), nullable=True, server_default=sa.text('0')))

    # 2. Make warehouse_id nullable in indents and change dates to DateTime
    with op.batch_alter_table('indents', schema=None) as batch_op:
        batch_op.alter_column('warehouse_id',
               existing_type=sa.BigInteger(),
               nullable=True)
        batch_op.alter_column('indent_date',
               existing_type=sa.Date(),
               type_=sa.DateTime(),
               existing_nullable=False)
        batch_op.alter_column('required_date',
               existing_type=sa.Date(),
               type_=sa.DateTime(),
               existing_nullable=True)


def downgrade() -> None:
    with op.batch_alter_table('indents', schema=None) as batch_op:
        batch_op.alter_column('required_date',
               existing_type=sa.DateTime(),
               type_=sa.Date(),
               existing_nullable=True)
        batch_op.alter_column('indent_date',
               existing_type=sa.DateTime(),
               type_=sa.Date(),
               existing_nullable=False)
        batch_op.alter_column('warehouse_id',
               existing_type=sa.BigInteger(),
               nullable=False)

    with op.batch_alter_table('items', schema=None) as batch_op:
        batch_op.drop_column('requires_quality_inspection')
