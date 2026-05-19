"""conditional_routing

Revision ID: d4e5f6070803
Revises: c3d4e5f60702
Create Date: 2026-04-22

Configurable workflow engine — Wave 3: per-level conditional routing.

Adds extra columns to `approval_levels` so a single workflow can split
its routing based on document context — e.g. "MMU-Krishna indents go to
the MMU coordinator; NTEP indents go to the program manager; everything
else falls through to the default chain."

Columns:
  - department    — exact string match against doc.department / doc.dept
  - category      — match against item / doc category (e.g. "drug", "equipment")
  - request_type  — urgent vs regular vs auto_reorder split
  - condition_json — extensible JSON rule for future field matching
                     (parsed in service layer; null = no extra constraints)

All four are NULL-defaulted so existing levels stay backwards-compatible:
NULL means "no constraint on this dimension".
"""
from alembic import op
import sqlalchemy as sa


revision = 'd4e5f6070803'
down_revision = 'c3d4e5f60702'
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table('approval_levels') as batch:
        batch.add_column(sa.Column('department', sa.String(100), nullable=True))
        batch.add_column(sa.Column('category', sa.String(100), nullable=True))
        batch.add_column(sa.Column('request_type', sa.String(50), nullable=True))
        batch.add_column(sa.Column('condition_json', sa.Text, nullable=True))


def downgrade() -> None:
    with op.batch_alter_table('approval_levels') as batch:
        batch.drop_column('condition_json')
        batch.drop_column('request_type')
        batch.drop_column('category')
        batch.drop_column('department')
