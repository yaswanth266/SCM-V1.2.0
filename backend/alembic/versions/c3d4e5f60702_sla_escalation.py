"""sla_escalation

Revision ID: c3d4e5f60702
Revises: b2c3d4e5f601
Create Date: 2026-04-22

Configurable workflow engine — Wave 2: SLA timers + escalation.

Adds:
  - approval_levels.escalation_user_id  — fallback approver if SLA breached
  - approval_levels.escalation_after_hours  — clock per level (0 = no SLA)
  - approval_requests.escalated_to_user_id  — who the request was escalated to
  - approval_requests.escalated_at  — when escalation fired
  - approval_requests.escalation_count  — number of times re-escalated

Indexes on (status, requested_at) so the breach scanner stays sub-millisecond
even when the table grows.
"""
from alembic import op
import sqlalchemy as sa


revision = 'c3d4e5f60702'
down_revision = 'b2c3d4e5f601'
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table('approval_levels') as batch:
        batch.add_column(sa.Column('escalation_user_id', sa.BigInteger(),
                                    sa.ForeignKey('users.id'), nullable=True))
        batch.add_column(sa.Column('escalation_after_hours', sa.Integer(),
                                    nullable=False, server_default='0'))

    with op.batch_alter_table('approval_requests') as batch:
        batch.add_column(sa.Column('escalated_to_user_id', sa.BigInteger(),
                                    sa.ForeignKey('users.id'), nullable=True))
        batch.add_column(sa.Column('escalated_at', sa.DateTime(), nullable=True))
        batch.add_column(sa.Column('escalation_count', sa.Integer(),
                                    nullable=False, server_default='0'))

    op.create_index(
        'ix_ar_status_requested',
        'approval_requests',
        ['status', 'requested_at'],
    )


def downgrade() -> None:
    op.drop_index('ix_ar_status_requested', 'approval_requests')
    with op.batch_alter_table('approval_requests') as batch:
        batch.drop_column('escalation_count')
        batch.drop_column('escalated_at')
        batch.drop_column('escalated_to_user_id')
    with op.batch_alter_table('approval_levels') as batch:
        batch.drop_column('escalation_after_hours')
        batch.drop_column('escalation_user_id')
