"""parallel_approvers

Revision ID: e5f607080904
Revises: d4e5f6070803
Create Date: 2026-04-22

Configurable workflow engine — Wave 4: parallel approvers.

Adds `requires_all` flag to approval_levels. When true, every eligible
approver at that level must approve before the level advances. Implemented
without a new table — we infer "have all approved" from existing
approval_history rows for the level.

Defaults to false so legacy single-approver behavior is unchanged.
"""
from alembic import op
import sqlalchemy as sa


revision = 'e5f607080904'
down_revision = 'd4e5f6070803'
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table('approval_levels') as batch:
        batch.add_column(sa.Column('requires_all', sa.Boolean(),
                                    nullable=False, server_default=sa.false()))


def downgrade() -> None:
    with op.batch_alter_table('approval_levels') as batch:
        batch.drop_column('requires_all')
