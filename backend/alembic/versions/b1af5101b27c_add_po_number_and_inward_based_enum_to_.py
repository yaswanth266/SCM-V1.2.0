"""add_po_number_and_inward_based_enum_to_grn

Revision ID: b1af5101b27c
Revises: 2937fe64b493
Create Date: 2026-05-20 14:58:07.842086

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'b1af5101b27c'
down_revision: Union[str, Sequence[str], None] = '2937fe64b493'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Add po_number column to goods_receipt_notes table
    op.add_column('goods_receipt_notes', sa.Column('po_number', sa.String(length=50), nullable=True))
    
    # Alter receipt_type column from Enum to String(50) to support 'inward_based'
    op.alter_column('goods_receipt_notes', 'receipt_type',
               type_=sa.String(length=50),
               existing_type=sa.Enum('po_based', 'direct', 'return', 'transfer', name='grn_receipt_type_enum'),
               existing_nullable=True)


def downgrade() -> None:
    # Drop po_number column from goods_receipt_notes table
    op.drop_column('goods_receipt_notes', 'po_number')
    
    # Revert receipt_type column back to Enum
    op.alter_column('goods_receipt_notes', 'receipt_type',
               type_=sa.Enum('po_based', 'direct', 'return', 'transfer', name='grn_receipt_type_enum'),
               existing_type=sa.String(length=50),
               existing_nullable=True)
