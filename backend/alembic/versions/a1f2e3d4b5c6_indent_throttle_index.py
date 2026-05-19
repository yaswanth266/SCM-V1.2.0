"""indent_throttle_index

Revision ID: a1f2e3d4b5c6
Revises: 8df72e378a3e
Create Date: 2026-04-22

Adds the composite index that backs the per-user 30-day indent submission
throttle. Without this, the cap check in /indents/{id}/submit becomes a full
scan once the indents table grows past a few hundred thousand rows — which
will happen quickly with 25k mobile users.
"""
from alembic import op


revision = 'a1f2e3d4b5c6'
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_index(
        'ix_indents_raised_by_created',
        'indents',
        ['raised_by', 'created_at'],
    )


def downgrade() -> None:
    op.drop_index('ix_indents_raised_by_created', 'indents')
