"""add_destination_warehouse_id_to_material_issue

Revision ID: 38a24c246f07
Revises: 439e5e4f7fcd
Create Date: 2026-05-22 15:52:10.149189

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '38a24c246f07'
down_revision: Union[str, Sequence[str], None] = '439e5e4f7fcd'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    with op.batch_alter_table('material_issues', schema=None) as batch_op:
        batch_op.add_column(sa.Column('destination_warehouse_id', sa.BigInteger(), nullable=True))
        batch_op.create_foreign_key(
            'fk_material_issues_destination_warehouse',
            'warehouses',
            ['destination_warehouse_id'],
            ['id'],
            ondelete='SET NULL'
        )


def downgrade() -> None:
    """Downgrade schema."""
    with op.batch_alter_table('material_issues', schema=None) as batch_op:
        batch_op.drop_constraint('fk_material_issues_destination_warehouse', type_='foreignkey')
        batch_op.drop_column('destination_warehouse_id')
