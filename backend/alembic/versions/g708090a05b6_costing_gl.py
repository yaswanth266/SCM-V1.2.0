"""costing_gl_wave6

Revision ID: g708090a05b6
Revises: f607080904a5
Create Date: 2026-04-23

Wave 6 — Real costing + finance integration.

Adds:
  - account_mappings: resolves which GL account to debit/credit per (txn_event,
    item_category, warehouse), with an org-wide default fallback.
  - fiscal_years: org fiscal calendar (closure flag exists but is not enforced
    yet — Wave 6 ships unenforced; later wave will add period-lock checks on
    journal posting).
  - chart_of_accounts.organization_id: previously the table was project-scoped
    only; CoA now belongs to an org so seed/lookup work without a project.
"""
from alembic import op
import sqlalchemy as sa


revision = 'g708090a05b6'
down_revision = 'f607080904a5'
branch_labels = None
depends_on = None


def upgrade() -> None:
    # 1. organization_id on chart_of_accounts (nullable so existing rows survive)
    op.add_column(
        'chart_of_accounts',
        sa.Column('organization_id', sa.BigInteger(), sa.ForeignKey('organizations.id'), nullable=True),
    )
    op.create_index('idx_coa_org', 'chart_of_accounts', ['organization_id'])

    # 2. account_mappings — resolves (event, item_category?, warehouse?) → debit/credit accounts
    op.create_table(
        'account_mappings',
        sa.Column('id', sa.BigInteger(), primary_key=True, autoincrement=True),
        sa.Column('organization_id', sa.BigInteger(), sa.ForeignKey('organizations.id'), nullable=False),
        sa.Column(
            'event',
            sa.Enum(
                'grn', 'invoice', 'payment', 'issue', 'return', 'consumption', 'opening_stock',
                name='gl_event_enum',
            ),
            nullable=False,
        ),
        sa.Column('item_category_id', sa.BigInteger(), sa.ForeignKey('item_categories.id'), nullable=True),
        sa.Column('warehouse_id', sa.BigInteger(), sa.ForeignKey('warehouses.id'), nullable=True),
        sa.Column('debit_account_id', sa.BigInteger(), sa.ForeignKey('chart_of_accounts.id'), nullable=True),
        sa.Column('credit_account_id', sa.BigInteger(), sa.ForeignKey('chart_of_accounts.id'), nullable=True),
        sa.Column('is_active', sa.Boolean(), default=True),
        sa.Column('created_at', sa.DateTime(), server_default=sa.func.now()),
    )
    op.create_index('idx_am_org_event', 'account_mappings', ['organization_id', 'event', 'is_active'])
    op.create_index('idx_am_lookup', 'account_mappings', ['event', 'item_category_id', 'warehouse_id'])

    # 3. fiscal_years
    op.create_table(
        'fiscal_years',
        sa.Column('id', sa.BigInteger(), primary_key=True, autoincrement=True),
        sa.Column('organization_id', sa.BigInteger(), sa.ForeignKey('organizations.id'), nullable=False),
        sa.Column('year_label', sa.String(20), nullable=False),
        sa.Column('start_date', sa.Date(), nullable=False),
        sa.Column('end_date', sa.Date(), nullable=False),
        sa.Column('is_closed', sa.Boolean(), default=False),
        sa.Column('closed_at', sa.DateTime(), nullable=True),
        sa.Column('closed_by', sa.BigInteger(), sa.ForeignKey('users.id'), nullable=True),
        sa.Column('created_at', sa.DateTime(), server_default=sa.func.now()),
    )
    op.create_index('idx_fy_org', 'fiscal_years', ['organization_id'])
    op.create_unique_constraint('uq_fy_org_label', 'fiscal_years', ['organization_id', 'year_label'])


def downgrade() -> None:
    op.drop_constraint('uq_fy_org_label', 'fiscal_years', type_='unique')
    op.drop_index('idx_fy_org', table_name='fiscal_years')
    op.drop_table('fiscal_years')

    op.drop_index('idx_am_lookup', table_name='account_mappings')
    op.drop_index('idx_am_org_event', table_name='account_mappings')
    op.drop_table('account_mappings')

    op.drop_index('idx_coa_org', table_name='chart_of_accounts')
    op.drop_column('chart_of_accounts', 'organization_id')
