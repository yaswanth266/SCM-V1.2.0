"""business_rules_engine

Revision ID: f607080904a5
Revises: e5f607080904
Create Date: 2026-04-22

Business Rules Engine — Wave 5.

Two new tables:
  - business_rules: declarative rule definitions (trigger + condition + action)
  - business_rule_executions: per-fire audit log (succeeded/skipped/failed)
"""
from alembic import op
import sqlalchemy as sa


revision = 'f607080904a5'
down_revision = 'e5f607080904'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        'business_rules',
        sa.Column('id', sa.BigInteger(), primary_key=True, autoincrement=True),
        sa.Column('name', sa.String(255), nullable=False),
        sa.Column('description', sa.Text(), nullable=True),
        sa.Column('trigger_event', sa.String(100), nullable=False),
        sa.Column('condition_json', sa.Text(), nullable=False),
        sa.Column('action_type', sa.String(50), nullable=False),
        sa.Column('action_config', sa.Text(), nullable=False),
        sa.Column('is_active', sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column('organization_id', sa.BigInteger(), nullable=True),
        sa.Column('created_by', sa.BigInteger(), sa.ForeignKey('users.id'), nullable=True),
        sa.Column('created_at', sa.DateTime(), nullable=False, server_default=sa.func.now()),
        sa.Column('last_fired_at', sa.DateTime(), nullable=True),
        sa.Column('fire_count', sa.Integer(), nullable=False, server_default='0'),
    )
    op.create_index('ix_br_event_active', 'business_rules', ['trigger_event', 'is_active'])

    op.create_table(
        'business_rule_executions',
        sa.Column('id', sa.BigInteger(), primary_key=True, autoincrement=True),
        sa.Column('rule_id', sa.BigInteger(), sa.ForeignKey('business_rules.id', ondelete='CASCADE'), nullable=False),
        sa.Column('fired_at', sa.DateTime(), nullable=False, server_default=sa.func.now()),
        sa.Column('trigger_context', sa.Text(), nullable=True),
        sa.Column('status', sa.String(20), nullable=False),  # success | skipped | failed
        sa.Column('result', sa.Text(), nullable=True),
        sa.Column('error', sa.Text(), nullable=True),
    )
    op.create_index('ix_bre_rule_fired', 'business_rule_executions', ['rule_id', 'fired_at'])


def downgrade() -> None:
    op.drop_index('ix_bre_rule_fired', 'business_rule_executions')
    op.drop_table('business_rule_executions')
    op.drop_index('ix_br_event_active', 'business_rules')
    op.drop_table('business_rules')
