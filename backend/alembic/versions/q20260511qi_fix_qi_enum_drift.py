"""fix quality inspection type enum drift

Revision ID: q20260511qi
Revises: 183d62b8604c
Create Date: 2026-05-11 10:35:00

"""
from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = 'q20260511qi'
down_revision = '183d62b8604c'
branch_labels = None
depends_on = None

def upgrade() -> None:
    # Change inspection_type from ENUM to VARCHAR(50) to support 'full', 'sample', etc.
    # The SQLAlchemy model already expects String(50).
    op.alter_column('quality_inspections', 'inspection_type',
               type_=sa.String(length=50),
               existing_type=sa.Enum('incoming', 'outgoing', name='inspection_type_enum'),
               existing_nullable=False,
               existing_server_default='incoming')

def downgrade() -> None:
    # This might fail if there's data like 'full' which isn't in the enum.
    # But for completeness:
    op.alter_column('quality_inspections', 'inspection_type',
               type_=sa.Enum('incoming', 'outgoing', name='inspection_type_enum'),
               existing_type=sa.String(length=50),
               existing_nullable=False,
               existing_server_default='incoming')
