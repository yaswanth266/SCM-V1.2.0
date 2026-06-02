"""add_inward_id_to_grn

Revision ID: 2937fe64b493
Revises: f148bcadea51
Create Date: 2026-05-20 12:37:25.772402

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '2937fe64b493'
down_revision: Union[str, Sequence[str], None] = 'f148bcadea51'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('goods_receipt_notes', sa.Column('inward_id', sa.BigInteger(), nullable=True))
    op.create_foreign_key('fk_goods_receipt_notes_inward_id', 'goods_receipt_notes', 'material_inwards', ['inward_id'], ['id'])


def downgrade() -> None:
    op.drop_constraint('fk_goods_receipt_notes_inward_id', 'goods_receipt_notes', type_='foreignkey')
    op.drop_column('goods_receipt_notes', 'inward_id')
