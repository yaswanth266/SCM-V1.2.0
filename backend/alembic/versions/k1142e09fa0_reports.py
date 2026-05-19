"""report_definitions

Revision ID: k1142e09fa0
Revises: j10314d08e9
Create Date: 2026-04-23

Wave 10 — Reporting overhaul.

  - report_definitions: saved pivot/timeseries report config
  - report_schedules: cron-style schedule for emailing reports
"""
from alembic import op
import sqlalchemy as sa


revision = 'k1142e09fa0'
down_revision = 'j10314d08e9'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        'report_definitions',
        sa.Column('id', sa.BigInteger(), primary_key=True, autoincrement=True),
        sa.Column('name', sa.String(255), nullable=False),
        sa.Column('description', sa.Text(), nullable=True),
        sa.Column('source_table', sa.String(80), nullable=False),
        sa.Column(
            'report_type',
            sa.Enum('pivot', 'timeseries', 'list', name='report_type_enum'),
            nullable=False, server_default='pivot',
        ),
        sa.Column('dimensions', sa.JSON(), nullable=True),
        sa.Column('measures', sa.JSON(), nullable=True),
        sa.Column('filters', sa.JSON(), nullable=True),
        sa.Column('chart_type', sa.String(40), nullable=True),
        sa.Column('is_shared', sa.Boolean(), server_default=sa.text('0')),
        sa.Column('created_by', sa.BigInteger(), sa.ForeignKey('users.id'), nullable=True),
        sa.Column('created_at', sa.DateTime(), server_default=sa.func.now()),
        sa.Column('updated_at', sa.DateTime(), server_default=sa.func.now(), onupdate=sa.func.now()),
    )
    op.create_index('idx_repdef_creator', 'report_definitions', ['created_by'])
    op.create_index('idx_repdef_shared', 'report_definitions', ['is_shared'])
    op.create_unique_constraint('uq_repdef_creator_name', 'report_definitions', ['created_by', 'name'])

    op.create_table(
        'report_schedules',
        sa.Column('id', sa.BigInteger(), primary_key=True, autoincrement=True),
        sa.Column('report_id', sa.BigInteger(), sa.ForeignKey('report_definitions.id', ondelete='CASCADE'), nullable=False),
        sa.Column(
            'frequency',
            sa.Enum('daily', 'weekly', 'monthly', name='report_freq_enum'),
            nullable=False,
        ),
        sa.Column('hour_of_day', sa.Integer(), server_default='9'),
        sa.Column('day_of_week', sa.Integer(), nullable=True),
        sa.Column('day_of_month', sa.Integer(), nullable=True),
        sa.Column('recipient_emails', sa.Text(), nullable=False),
        sa.Column('format', sa.Enum('csv', 'pdf', 'html', name='report_format_enum'), server_default='csv'),
        sa.Column('is_active', sa.Boolean(), server_default=sa.text('1')),
        sa.Column('last_run_at', sa.DateTime(), nullable=True),
        sa.Column('last_run_status', sa.String(40), nullable=True),
        sa.Column('next_run_at', sa.DateTime(), nullable=True),
        sa.Column('created_at', sa.DateTime(), server_default=sa.func.now()),
    )
    op.create_index('idx_repsched_report', 'report_schedules', ['report_id'])
    op.create_index('idx_repsched_next', 'report_schedules', ['is_active', 'next_run_at'])


def downgrade() -> None:
    op.drop_index('idx_repsched_next', table_name='report_schedules')
    op.drop_index('idx_repsched_report', table_name='report_schedules')
    op.drop_table('report_schedules')

    op.drop_constraint('uq_repdef_creator_name', 'report_definitions', type_='unique')
    op.drop_index('idx_repdef_shared', table_name='report_definitions')
    op.drop_index('idx_repdef_creator', table_name='report_definitions')
    op.drop_table('report_definitions')
