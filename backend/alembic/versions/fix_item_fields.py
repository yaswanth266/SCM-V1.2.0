"""fix_item_fields

Revision ID: fix_item_fields_v2
Revises: q20260511qi
Create Date: 2026-05-13 13:05:00.000000

"""
from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa
from sqlalchemy.engine.reflection import Inspector

# revision identifiers, used by Alembic.
revision: str = 'fix_item_fields_v2'
down_revision: Union[str, Sequence[str], None] = 'q20260511qi'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    conn = op.get_bind()
    inspector = Inspector.from_engine(conn)
    
    # Check current indices on 'items'
    indexes = inspector.get_indexes('items')
    index_names = [idx['name'] for idx in indexes]
    
    with op.batch_alter_table('items', schema=None) as batch_op:
        if 'brand' in index_names:
            batch_op.drop_index('brand')
        if 'generic_name' in index_names:
            batch_op.drop_index('generic_name')
            
        # Update columns
        batch_op.alter_column('brand',
               existing_type=sa.String(length=255),
               nullable=True)
        batch_op.alter_column('generic_name',
               existing_type=sa.String(length=255),
               nullable=True)

    # Check for FK
    fks = inspector.get_foreign_keys('items')
    fk_names = [fk['name'] for fk in fks]
    # If no FK to brands exists, we might want to add it, 
    # but let's stick to the user's specific request about unique constraints.


def downgrade() -> None:
    pass
