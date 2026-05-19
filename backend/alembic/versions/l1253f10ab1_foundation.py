"""foundation_wave11

Revision ID: l1253f10ab1
Revises: k1142e09fa0
Create Date: 2026-04-23

Wave 11 — Foundation Fix (item codes, fiscal-year numbering, traceability).

This migration is intentionally idempotent: each alter is wrapped in a
"if column doesn't exist" check, because UAT/PROD may have had some of these
columns added manually during firefighting.
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect


revision = 'l1253f10ab1'
down_revision = 'k1142e09fa0'
branch_labels = None
depends_on = None


def _has_column(bind, table: str, column: str) -> bool:
    insp = inspect(bind)
    return any(c["name"] == column for c in insp.get_columns(table))


def _has_index(bind, table: str, index: str) -> bool:
    insp = inspect(bind)
    return any(ix["name"] == index for ix in insp.get_indexes(table))


def _safe_add(bind, table: str, column_name: str, column_def: sa.Column) -> None:
    if not _has_column(bind, table, column_name):
        op.add_column(table, column_def)


def _safe_idx(bind, table: str, name: str, cols: list[str]) -> None:
    if not _has_index(bind, table, name):
        op.create_index(name, table, cols)


def upgrade() -> None:
    bind = op.get_bind()

    # 1. Item category coding
    _safe_add(bind, 'item_categories', 'code_prefix',
              sa.Column('code_prefix', sa.String(10), nullable=True))
    _safe_idx(bind, 'item_categories', 'idx_itemcat_prefix', ['code_prefix'])

    # 2. Item form code + coding status
    _safe_add(bind, 'items', 'dosage_form_code',
              sa.Column('dosage_form_code', sa.String(2), nullable=True))
    _safe_add(bind, 'items', 'coding_status',
              sa.Column(
                  'coding_status',
                  sa.Enum('auto', 'manual', 'legacy', name='item_coding_status_enum'),
                  nullable=True, server_default='legacy',
              ))
    _safe_idx(bind, 'items', 'idx_item_form_code', ['dosage_form_code'])

    # 3. Number series — org prefix + custom format
    _safe_add(bind, 'number_series', 'org_prefix',
              sa.Column('org_prefix', sa.String(20), nullable=True, server_default='BHSPL'))
    _safe_add(bind, 'number_series', 'format_template',
              sa.Column('format_template', sa.String(255), nullable=True))
    _safe_idx(bind, 'number_series', 'idx_numseries_fy',
              ['module', 'document_type', 'fiscal_year'])

    # 4. MR back-link to Indent — column already exists as indent_id
    _safe_idx(bind, 'material_requests', 'idx_mr_indent', ['indent_id'])

    # 5. Consumption back-link to issuing MaterialIssue
    _safe_add(bind, 'consumption_entries', 'source_issue_id',
              sa.Column('source_issue_id', sa.BigInteger(), nullable=True))
    _safe_idx(bind, 'consumption_entries', 'idx_consumption_source_issue', ['source_issue_id'])


def downgrade() -> None:
    bind = op.get_bind()
    if _has_index(bind, 'consumption_entries', 'idx_consumption_source_issue'):
        op.drop_index('idx_consumption_source_issue', table_name='consumption_entries')
    if _has_column(bind, 'consumption_entries', 'source_issue_id'):
        op.drop_column('consumption_entries', 'source_issue_id')

    if _has_index(bind, 'material_requests', 'idx_mr_indent'):
        op.drop_index('idx_mr_indent', table_name='material_requests')

    if _has_index(bind, 'number_series', 'idx_numseries_fy'):
        op.drop_index('idx_numseries_fy', table_name='number_series')
    if _has_column(bind, 'number_series', 'format_template'):
        op.drop_column('number_series', 'format_template')
    if _has_column(bind, 'number_series', 'org_prefix'):
        op.drop_column('number_series', 'org_prefix')

    if _has_index(bind, 'items', 'idx_item_form_code'):
        op.drop_index('idx_item_form_code', table_name='items')
    if _has_column(bind, 'items', 'coding_status'):
        op.drop_column('items', 'coding_status')
    if _has_column(bind, 'items', 'dosage_form_code'):
        op.drop_column('items', 'dosage_form_code')

    if _has_index(bind, 'item_categories', 'idx_itemcat_prefix'):
        op.drop_index('idx_itemcat_prefix', table_name='item_categories')
    if _has_column(bind, 'item_categories', 'code_prefix'):
        op.drop_column('item_categories', 'code_prefix')
