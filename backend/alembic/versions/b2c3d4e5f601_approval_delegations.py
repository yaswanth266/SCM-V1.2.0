"""approval_delegations

Revision ID: b2c3d4e5f601
Revises: a1f2e3d4b5c6
Create Date: 2026-04-22

Configurable workflow engine — Wave 1: approval delegation.

Adds the `approval_delegations` table so any approver can delegate their
incoming approvals to a colleague for a date window (e.g. while on leave).

Optional `scope_module` lets the delegation cover a specific module only
(e.g. delegate just `procurement` approvals while keeping indent/MR
decisions yourself).
"""
from alembic import op
import sqlalchemy as sa


revision = 'b2c3d4e5f601'
down_revision = 'a1f2e3d4b5c6'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        'approval_delegations',
        sa.Column('id', sa.BigInteger(), primary_key=True, autoincrement=True),
        sa.Column('delegator_id', sa.BigInteger(), sa.ForeignKey('users.id', ondelete='CASCADE'), nullable=False),
        sa.Column('delegatee_id', sa.BigInteger(), sa.ForeignKey('users.id', ondelete='CASCADE'), nullable=False),
        sa.Column('valid_from', sa.DateTime(), nullable=False),
        sa.Column('valid_to', sa.DateTime(), nullable=False),
        sa.Column('scope_module', sa.String(100), nullable=True),
        sa.Column('reason', sa.Text(), nullable=True),
        sa.Column('is_active', sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column('created_at', sa.DateTime(), nullable=False, server_default=sa.func.now()),
        sa.Column('revoked_at', sa.DateTime(), nullable=True),
    )
    op.create_index(
        'ix_appdel_delegator_active',
        'approval_delegations',
        ['delegator_id', 'is_active'],
    )
    op.create_index(
        'ix_appdel_delegatee_active',
        'approval_delegations',
        ['delegatee_id', 'is_active'],
    )


def downgrade() -> None:
    op.drop_index('ix_appdel_delegatee_active', 'approval_delegations')
    op.drop_index('ix_appdel_delegator_active', 'approval_delegations')
    op.drop_table('approval_delegations')
