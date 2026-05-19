"""scm_workflow_rebuild

Foundational schema migration for the BHSPL SCM workflow rebuild
(2026-04-30 design).

Adds fulfillment tracking columns to ``indent_items``, an
``active_role_id`` switcher on ``users``, the new ``mr_buckets``
demand-pool table, and a ``reservation_timeout_hours`` system setting.

Revision ID: q17a8e15ff6
Revises: p1697d14ef5
Create Date: 2026-04-30
"""
from alembic import op
import sqlalchemy as sa


revision = 'q17a8e15ff6'
down_revision = 'p1697d14ef5'
branch_labels = None
depends_on = None


def upgrade():
    op.add_column('indent_items', sa.Column('fulfillment_route',
        sa.Enum('pending_decision','issue','procure','partial_split',
                name='fulfillment_route'),
        nullable=False, server_default='pending_decision'))
    op.add_column('indent_items', sa.Column('fulfillment_status',
        sa.Enum('pending','reserved','in_mr_bucket','in_mr_draft','in_po',
                'awaiting_inward','inward_received','picking','picked',
                'packed','qc_passed','at_gate','in_transit','delivered',
                'acknowledged', name='line_fulfillment_status'),
        nullable=False, server_default='pending'))
    op.add_column('indent_items', sa.Column('parent_item_id', sa.BigInteger(), nullable=True))
    op.add_column('indent_items', sa.Column('reserved_at', sa.DateTime(), nullable=True))
    op.create_foreign_key('fk_indent_items_parent', 'indent_items', 'indent_items',
                          ['parent_item_id'], ['id'])
    op.create_index('idx_fulfillment_status', 'indent_items', ['fulfillment_status'])
    op.create_index('idx_reserved_at', 'indent_items', ['reserved_at'])

    op.add_column('users', sa.Column('active_role_id', sa.BigInteger(), nullable=True))
    op.create_foreign_key('fk_users_active_role', 'users', 'roles',
                          ['active_role_id'], ['id'])

    op.create_table('mr_buckets',
        sa.Column('id', sa.BigInteger(), primary_key=True),
        sa.Column('indent_item_id', sa.BigInteger(),
                  sa.ForeignKey('indent_items.id', name='fk_mr_buckets_indent_item'),
                  nullable=False),
        sa.Column('warehouse_id', sa.BigInteger(),
                  sa.ForeignKey('warehouses.id', name='fk_mr_buckets_warehouse'),
                  nullable=False),
        sa.Column('item_id', sa.BigInteger(),
                  sa.ForeignKey('items.id', name='fk_mr_buckets_item'),
                  nullable=False),
        sa.Column('qty', sa.Numeric(15, 3), nullable=False),
        sa.Column('required_date', sa.Date(), nullable=False),
        sa.Column('status', sa.Enum('pooled','in_run','in_mr', name='mr_bucket_status'),
                  nullable=False, server_default='pooled'),
        sa.Column('mrp_run_id', sa.BigInteger(),
                  sa.ForeignKey('mrp_runs.id', name='fk_mr_buckets_mrp_run'),
                  nullable=True),
        sa.Column('material_request_id', sa.BigInteger(),
                  sa.ForeignKey('material_requests.id', name='fk_mr_buckets_mr'),
                  nullable=True),
        sa.Column('created_at', sa.DateTime(), server_default=sa.func.current_timestamp(), nullable=False),
    )
    op.create_index('idx_bucket_window', 'mr_buckets', ['warehouse_id', 'required_date', 'status'])
    op.create_index('idx_bucket_indent_item', 'mr_buckets', ['indent_item_id'])
    op.create_index('idx_bucket_mr', 'mr_buckets', ['material_request_id'])

    # Add material_issue discriminator to existing picking/packing tables
    op.add_column('picking_orders',
        sa.Column('material_issue_id', sa.BigInteger(), nullable=True))
    op.create_foreign_key('fk_picking_orders_mi', 'picking_orders',
        'material_issues', ['material_issue_id'], ['id'])
    op.create_index('idx_picking_orders_mi', 'picking_orders', ['material_issue_id'])

    op.add_column('packing_orders',
        sa.Column('material_issue_id', sa.BigInteger(), nullable=True))
    op.create_foreign_key('fk_packing_orders_mi', 'packing_orders',
        'material_issues', ['material_issue_id'], ['id'])
    op.create_index('idx_packing_orders_mi', 'packing_orders', ['material_issue_id'])

    op.execute("""
        INSERT INTO system_settings (setting_key, setting_value, setting_type, description)
        SELECT 'reservation_timeout_hours', '24', 'number',
               'Hours that wh-mgr stock reservations hold before auto-release'
        WHERE NOT EXISTS (
            SELECT 1 FROM system_settings WHERE setting_key='reservation_timeout_hours'
        )
    """)


def downgrade():
    op.execute("DELETE FROM system_settings WHERE setting_key='reservation_timeout_hours'")
    op.drop_index('idx_packing_orders_mi', table_name='packing_orders')
    op.drop_constraint('fk_packing_orders_mi', 'packing_orders', type_='foreignkey')
    op.drop_column('packing_orders', 'material_issue_id')
    op.drop_index('idx_picking_orders_mi', table_name='picking_orders')
    op.drop_constraint('fk_picking_orders_mi', 'picking_orders', type_='foreignkey')
    op.drop_column('picking_orders', 'material_issue_id')
    op.drop_index('idx_bucket_mr', table_name='mr_buckets')
    op.drop_index('idx_bucket_indent_item', table_name='mr_buckets')
    op.drop_index('idx_bucket_window', table_name='mr_buckets')
    op.drop_table('mr_buckets')
    op.drop_constraint('fk_users_active_role', 'users', type_='foreignkey')
    op.drop_column('users', 'active_role_id')
    op.drop_index('idx_reserved_at', table_name='indent_items')
    op.drop_index('idx_fulfillment_status', table_name='indent_items')
    op.drop_constraint('fk_indent_items_parent', 'indent_items', type_='foreignkey')
    op.drop_column('indent_items', 'reserved_at')
    op.drop_column('indent_items', 'parent_item_id')
    op.drop_column('indent_items', 'fulfillment_status')
    op.drop_column('indent_items', 'fulfillment_route')
