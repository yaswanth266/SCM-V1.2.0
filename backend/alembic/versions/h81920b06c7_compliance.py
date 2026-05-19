"""healthcare_compliance_pack

Revision ID: h81920b06c7
Revises: g708090a05b6
Create Date: 2026-04-23

Wave 7 — Healthcare compliance.

  - vendors: drug_license_number, drug_license_state, drug_license_expiry,
    gst_certificate_url, license_doc_url, vendor_compliance_status
  - items: drug_schedule, is_schedule_h1, is_narcotic, requires_prescription,
    requires_cold_chain, min_storage_temp_c, max_storage_temp_c, regulatory_notes
  - prescription_records: per-dispense audit (H1, narcotic, schedule X)
  - cold_chain_logs: temperature readings on batches
  - e_signatures: re-auth signature snapshots for consumption / issue
  - compliance_audits: generic event log (license_expired_block, h1_dispensed, etc.)
"""
from alembic import op
import sqlalchemy as sa


revision = 'h81920b06c7'
down_revision = 'g708090a05b6'
branch_labels = None
depends_on = None


def upgrade() -> None:
    # 1. Vendor compliance fields
    op.add_column('vendors', sa.Column('drug_license_number', sa.String(50), nullable=True))
    op.add_column('vendors', sa.Column('drug_license_state', sa.String(100), nullable=True))
    op.add_column('vendors', sa.Column('drug_license_expiry', sa.Date(), nullable=True))
    op.add_column('vendors', sa.Column('gst_certificate_url', sa.String(500), nullable=True))
    op.add_column('vendors', sa.Column('license_doc_url', sa.String(500), nullable=True))
    op.add_column('vendors', sa.Column(
        'vendor_compliance_status',
        sa.Enum('compliant', 'expiring_soon', 'expired', 'not_required', name='vendor_compliance_status_enum'),
        nullable=True,
        server_default='not_required',
    ))
    op.create_index('idx_vendor_license_expiry', 'vendors', ['drug_license_expiry'])

    # 2. Item compliance fields
    op.add_column('items', sa.Column(
        'drug_schedule',
        sa.Enum('X', 'H', 'H1', 'G', 'OTC', 'none', name='drug_schedule_enum'),
        nullable=True, server_default='none',
    ))
    op.add_column('items', sa.Column('is_schedule_h1', sa.Boolean(), server_default=sa.text('0')))
    op.add_column('items', sa.Column('is_narcotic', sa.Boolean(), server_default=sa.text('0')))
    op.add_column('items', sa.Column('requires_prescription', sa.Boolean(), server_default=sa.text('0')))
    op.add_column('items', sa.Column('requires_cold_chain', sa.Boolean(), server_default=sa.text('0')))
    op.add_column('items', sa.Column('min_storage_temp_c', sa.Numeric(5, 2), nullable=True))
    op.add_column('items', sa.Column('max_storage_temp_c', sa.Numeric(5, 2), nullable=True))
    op.add_column('items', sa.Column('regulatory_notes', sa.Text(), nullable=True))

    # 3. prescription_records — H1/narcotic/X dispense audit
    op.create_table(
        'prescription_records',
        sa.Column('id', sa.BigInteger(), primary_key=True, autoincrement=True),
        sa.Column('source_type', sa.Enum('material_issue', 'consumption_entry', name='presc_source_enum'), nullable=False),
        sa.Column('source_id', sa.BigInteger(), nullable=False),
        sa.Column('item_id', sa.BigInteger(), sa.ForeignKey('items.id'), nullable=False),
        sa.Column('batch_id', sa.BigInteger(), sa.ForeignKey('batches.id'), nullable=True),
        sa.Column('qty_dispensed', sa.Numeric(15, 3), nullable=False),
        sa.Column('drug_schedule', sa.String(10), nullable=True),
        sa.Column('prescriber_name', sa.String(255), nullable=False),
        sa.Column('prescriber_license', sa.String(100), nullable=False),
        sa.Column('patient_name', sa.String(255), nullable=True),
        sa.Column('patient_id', sa.String(100), nullable=True),
        sa.Column('prescription_image_url', sa.String(500), nullable=True),
        sa.Column('dispensed_by', sa.BigInteger(), sa.ForeignKey('users.id'), nullable=False),
        sa.Column('dispensed_at', sa.DateTime(), nullable=False, server_default=sa.func.now()),
        sa.Column('retention_until', sa.Date(), nullable=True),
        sa.Column('notes', sa.Text(), nullable=True),
    )
    op.create_index('idx_presc_item', 'prescription_records', ['item_id'])
    op.create_index('idx_presc_source', 'prescription_records', ['source_type', 'source_id'])
    op.create_index('idx_presc_date', 'prescription_records', ['dispensed_at'])

    # 4. cold_chain_logs — periodic temp readings on batches
    op.create_table(
        'cold_chain_logs',
        sa.Column('id', sa.BigInteger(), primary_key=True, autoincrement=True),
        sa.Column('batch_id', sa.BigInteger(), sa.ForeignKey('batches.id'), nullable=False),
        sa.Column('warehouse_id', sa.BigInteger(), sa.ForeignKey('warehouses.id'), nullable=True),
        sa.Column('reading_at', sa.DateTime(), nullable=False, server_default=sa.func.now()),
        sa.Column('temperature_c', sa.Numeric(5, 2), nullable=False),
        sa.Column('humidity_pct', sa.Numeric(5, 2), nullable=True),
        sa.Column('is_breach', sa.Boolean(), server_default=sa.text('0')),
        sa.Column('breach_severity', sa.Enum('minor', 'major', 'critical', name='cold_breach_enum'), nullable=True),
        sa.Column('recorded_by', sa.BigInteger(), sa.ForeignKey('users.id'), nullable=True),
        sa.Column('notes', sa.Text(), nullable=True),
    )
    op.create_index('idx_cclog_batch', 'cold_chain_logs', ['batch_id'])
    op.create_index('idx_cclog_breach', 'cold_chain_logs', ['is_breach'])
    op.create_index('idx_cclog_date', 'cold_chain_logs', ['reading_at'])

    # 5. e_signatures — re-auth audit
    op.create_table(
        'e_signatures',
        sa.Column('id', sa.BigInteger(), primary_key=True, autoincrement=True),
        sa.Column('source_type', sa.String(50), nullable=False),
        sa.Column('source_id', sa.BigInteger(), nullable=False),
        sa.Column('signer_user_id', sa.BigInteger(), sa.ForeignKey('users.id'), nullable=False),
        sa.Column('signed_at', sa.DateTime(), nullable=False, server_default=sa.func.now()),
        sa.Column('payload_hash', sa.String(128), nullable=False),
        sa.Column('signature_method', sa.String(50), server_default='password_reauth'),
        sa.Column('client_ip', sa.String(45), nullable=True),
        sa.Column('client_meta', sa.Text(), nullable=True),
    )
    op.create_index('idx_esig_source', 'e_signatures', ['source_type', 'source_id'])
    op.create_index('idx_esig_signer', 'e_signatures', ['signer_user_id'])

    # 6. compliance_audits — generic event log
    op.create_table(
        'compliance_audits',
        sa.Column('id', sa.BigInteger(), primary_key=True, autoincrement=True),
        sa.Column('event_type', sa.String(80), nullable=False),
        sa.Column('severity', sa.Enum('info', 'warning', 'error', 'critical', name='compliance_severity_enum'), server_default='info'),
        sa.Column('vendor_id', sa.BigInteger(), nullable=True),
        sa.Column('item_id', sa.BigInteger(), nullable=True),
        sa.Column('batch_id', sa.BigInteger(), nullable=True),
        sa.Column('source_type', sa.String(50), nullable=True),
        sa.Column('source_id', sa.BigInteger(), nullable=True),
        sa.Column('user_id', sa.BigInteger(), nullable=True),
        sa.Column('payload', sa.Text(), nullable=True),
        sa.Column('created_at', sa.DateTime(), nullable=False, server_default=sa.func.now()),
    )
    op.create_index('idx_cmpaudit_event', 'compliance_audits', ['event_type'])
    op.create_index('idx_cmpaudit_severity', 'compliance_audits', ['severity'])
    op.create_index('idx_cmpaudit_date', 'compliance_audits', ['created_at'])

    # 7. consumption_entries — add e-signature ref + h1 prescriber columns
    op.add_column('consumption_entries', sa.Column('e_signature_id', sa.BigInteger(), nullable=True))
    op.add_column('consumption_entries', sa.Column('prescriber_name', sa.String(255), nullable=True))
    op.add_column('consumption_entries', sa.Column('prescriber_license', sa.String(100), nullable=True))

    # 8. material_issue_items — H1 prescriber columns (line-level since one issue may
    # contain a mix of H1 and OTC items; attaching at line keeps it precise)
    op.add_column('material_issue_items', sa.Column('prescriber_name', sa.String(255), nullable=True))
    op.add_column('material_issue_items', sa.Column('prescriber_license', sa.String(100), nullable=True))
    op.add_column('material_issue_items', sa.Column('patient_name', sa.String(255), nullable=True))
    op.add_column('material_issue_items', sa.Column('patient_id_text', sa.String(100), nullable=True))


def downgrade() -> None:
    op.drop_column('material_issue_items', 'patient_id_text')
    op.drop_column('material_issue_items', 'patient_name')
    op.drop_column('material_issue_items', 'prescriber_license')
    op.drop_column('material_issue_items', 'prescriber_name')

    op.drop_column('consumption_entries', 'prescriber_license')
    op.drop_column('consumption_entries', 'prescriber_name')
    op.drop_column('consumption_entries', 'e_signature_id')

    op.drop_index('idx_cmpaudit_date', table_name='compliance_audits')
    op.drop_index('idx_cmpaudit_severity', table_name='compliance_audits')
    op.drop_index('idx_cmpaudit_event', table_name='compliance_audits')
    op.drop_table('compliance_audits')

    op.drop_index('idx_esig_signer', table_name='e_signatures')
    op.drop_index('idx_esig_source', table_name='e_signatures')
    op.drop_table('e_signatures')

    op.drop_index('idx_cclog_date', table_name='cold_chain_logs')
    op.drop_index('idx_cclog_breach', table_name='cold_chain_logs')
    op.drop_index('idx_cclog_batch', table_name='cold_chain_logs')
    op.drop_table('cold_chain_logs')

    op.drop_index('idx_presc_date', table_name='prescription_records')
    op.drop_index('idx_presc_source', table_name='prescription_records')
    op.drop_index('idx_presc_item', table_name='prescription_records')
    op.drop_table('prescription_records')

    op.drop_column('items', 'regulatory_notes')
    op.drop_column('items', 'max_storage_temp_c')
    op.drop_column('items', 'min_storage_temp_c')
    op.drop_column('items', 'requires_cold_chain')
    op.drop_column('items', 'requires_prescription')
    op.drop_column('items', 'is_narcotic')
    op.drop_column('items', 'is_schedule_h1')
    op.drop_column('items', 'drug_schedule')

    op.drop_index('idx_vendor_license_expiry', table_name='vendors')
    op.drop_column('vendors', 'vendor_compliance_status')
    op.drop_column('vendors', 'license_doc_url')
    op.drop_column('vendors', 'gst_certificate_url')
    op.drop_column('vendors', 'drug_license_expiry')
    op.drop_column('vendors', 'drug_license_state')
    op.drop_column('vendors', 'drug_license_number')
