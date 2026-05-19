"""mrp_runs

Revision ID: j10314d08e9
Revises: i9203c07d8
Create Date: 2026-04-23

Wave 9 — Demand planning + MRP.

  - mrp_runs: header for one planning run (date, horizon, method, status)
  - mrp_run_items: per-item recommendation rows (current, on_order, forecast,
    safety, net_required, suggested_vendor_id, generated_po_id)
"""
from alembic import op
import sqlalchemy as sa


revision = 'j10314d08e9'
down_revision = 'i9203c07d8'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        'mrp_runs',
        sa.Column('id', sa.BigInteger(), primary_key=True, autoincrement=True),
        sa.Column('run_number', sa.String(50), nullable=False, unique=True),
        sa.Column('run_date', sa.DateTime(), nullable=False, server_default=sa.func.now()),
        sa.Column('horizon_days', sa.Integer(), nullable=False, server_default='30'),
        sa.Column('history_days', sa.Integer(), nullable=False, server_default='90'),
        sa.Column('method', sa.Enum('moving_average', 'weighted_average', 'seasonal',
                                     name='mrp_method_enum'), nullable=False, server_default='moving_average'),
        sa.Column('warehouse_id', sa.BigInteger(), sa.ForeignKey('warehouses.id'), nullable=True),
        sa.Column('item_category_id', sa.BigInteger(), sa.ForeignKey('item_categories.id'), nullable=True),
        sa.Column('status', sa.Enum('draft', 'computed', 'po_generated', 'closed',
                                     name='mrp_status_enum'), server_default='draft'),
        sa.Column('total_items', sa.Integer(), server_default='0'),
        sa.Column('items_needing_reorder', sa.Integer(), server_default='0'),
        sa.Column('total_suggested_value', sa.Numeric(15, 2), server_default='0'),
        sa.Column('notes', sa.Text(), nullable=True),
        sa.Column('created_by', sa.BigInteger(), sa.ForeignKey('users.id'), nullable=True),
        sa.Column('created_at', sa.DateTime(), server_default=sa.func.now()),
    )
    op.create_index('idx_mrp_run_date', 'mrp_runs', ['run_date'])

    op.create_table(
        'mrp_run_items',
        sa.Column('id', sa.BigInteger(), primary_key=True, autoincrement=True),
        sa.Column('run_id', sa.BigInteger(), sa.ForeignKey('mrp_runs.id', ondelete='CASCADE'), nullable=False),
        sa.Column('item_id', sa.BigInteger(), sa.ForeignKey('items.id'), nullable=False),
        sa.Column('current_stock', sa.Numeric(15, 3), server_default='0'),
        sa.Column('on_order_qty', sa.Numeric(15, 3), server_default='0'),
        sa.Column('reserved_qty', sa.Numeric(15, 3), server_default='0'),
        sa.Column('forecast_qty', sa.Numeric(15, 3), server_default='0'),
        sa.Column('safety_stock', sa.Numeric(15, 3), server_default='0'),
        sa.Column('reorder_level', sa.Numeric(15, 3), server_default='0'),
        sa.Column('net_required', sa.Numeric(15, 3), server_default='0'),
        sa.Column('suggested_qty', sa.Numeric(15, 3), server_default='0'),
        sa.Column('suggested_vendor_id', sa.BigInteger(), sa.ForeignKey('vendors.id'), nullable=True),
        sa.Column('suggested_rate', sa.Numeric(15, 2), server_default='0'),
        sa.Column('lead_time_days', sa.Integer(), server_default='0'),
        sa.Column('confidence_pct', sa.Numeric(5, 2), server_default='0'),
        sa.Column('selected', sa.Boolean(), server_default=sa.text('1')),
        sa.Column('generated_po_id', sa.BigInteger(), nullable=True),
        sa.Column('notes', sa.Text(), nullable=True),
    )
    op.create_index('idx_mri_run', 'mrp_run_items', ['run_id'])
    op.create_index('idx_mri_item', 'mrp_run_items', ['item_id'])
    op.create_index('idx_mri_vendor', 'mrp_run_items', ['suggested_vendor_id'])


def downgrade() -> None:
    op.drop_index('idx_mri_vendor', table_name='mrp_run_items')
    op.drop_index('idx_mri_item', table_name='mrp_run_items')
    op.drop_index('idx_mri_run', table_name='mrp_run_items')
    op.drop_table('mrp_run_items')

    op.drop_index('idx_mrp_run_date', table_name='mrp_runs')
    op.drop_table('mrp_runs')
