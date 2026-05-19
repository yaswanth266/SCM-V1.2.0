"""document_management

Revision ID: i9203c07d8
Revises: h81920b06c7
Create Date: 2026-04-23

Wave 8 — Document management.

  - file_attachments: add document_id (groups versions), version_number,
    sha256, change_note, is_current, category
  - document_groups: top-level "document" entity that owns a chain of versions
  - document_templates: reusable PDF/email/text templates with placeholders
  - state_transition_rules: per-module/(from,to)-state e-sign requirement
"""
from alembic import op
import sqlalchemy as sa


revision = 'i9203c07d8'
down_revision = 'h81920b06c7'
branch_labels = None
depends_on = None


def upgrade() -> None:
    # 1. document_groups — logical "document" with a version chain
    op.create_table(
        'document_groups',
        sa.Column('id', sa.BigInteger(), primary_key=True, autoincrement=True),
        sa.Column('name', sa.String(255), nullable=False),
        sa.Column('description', sa.Text(), nullable=True),
        sa.Column('category', sa.String(80), nullable=True),
        sa.Column('source_type', sa.String(80), nullable=True),
        sa.Column('source_id', sa.BigInteger(), nullable=True),
        sa.Column('current_version_id', sa.BigInteger(), nullable=True),
        sa.Column('current_version_number', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('is_archived', sa.Boolean(), server_default=sa.text('0')),
        sa.Column('created_by', sa.BigInteger(), sa.ForeignKey('users.id'), nullable=True),
        sa.Column('created_at', sa.DateTime(), server_default=sa.func.now()),
        sa.Column('updated_at', sa.DateTime(), server_default=sa.func.now(), onupdate=sa.func.now()),
    )
    op.create_index('idx_docgroup_source', 'document_groups', ['source_type', 'source_id'])
    op.create_index('idx_docgroup_category', 'document_groups', ['category'])

    # 2. file_attachments — extend with versioning fields
    op.add_column('file_attachments', sa.Column('document_group_id', sa.BigInteger(), nullable=True))
    op.add_column('file_attachments', sa.Column('version_number', sa.Integer(), nullable=False, server_default='1'))
    op.add_column('file_attachments', sa.Column('sha256', sa.String(64), nullable=True))
    op.add_column('file_attachments', sa.Column('change_note', sa.Text(), nullable=True))
    op.add_column('file_attachments', sa.Column('is_current_version', sa.Boolean(), nullable=False, server_default=sa.text('1')))
    op.add_column('file_attachments', sa.Column('category', sa.String(80), nullable=True))
    op.create_index('idx_fa_group', 'file_attachments', ['document_group_id'])
    op.create_index('idx_fa_sha256', 'file_attachments', ['sha256'])

    # 3. document_templates
    op.create_table(
        'document_templates',
        sa.Column('id', sa.BigInteger(), primary_key=True, autoincrement=True),
        sa.Column('name', sa.String(255), nullable=False),
        sa.Column('description', sa.Text(), nullable=True),
        sa.Column('template_type', sa.Enum('email', 'pdf', 'text', 'html', name='doc_template_type_enum'), nullable=False),
        sa.Column('module', sa.String(50), nullable=True),
        sa.Column('subject_template', sa.String(500), nullable=True),
        sa.Column('body_template', sa.Text(), nullable=False),
        sa.Column('placeholders', sa.JSON(), nullable=True),
        sa.Column('is_active', sa.Boolean(), server_default=sa.text('1')),
        sa.Column('created_by', sa.BigInteger(), sa.ForeignKey('users.id'), nullable=True),
        sa.Column('created_at', sa.DateTime(), server_default=sa.func.now()),
        sa.Column('updated_at', sa.DateTime(), server_default=sa.func.now(), onupdate=sa.func.now()),
    )
    op.create_index('idx_doctpl_module', 'document_templates', ['module', 'is_active'])
    op.create_unique_constraint('uq_doctpl_name', 'document_templates', ['name'])

    # 4. state_transition_rules
    op.create_table(
        'state_transition_rules',
        sa.Column('id', sa.BigInteger(), primary_key=True, autoincrement=True),
        sa.Column('module', sa.String(50), nullable=False),
        sa.Column('source_type', sa.String(50), nullable=False),
        sa.Column('from_state', sa.String(50), nullable=True),
        sa.Column('to_state', sa.String(50), nullable=False),
        sa.Column('requires_e_sign', sa.Boolean(), server_default=sa.text('0')),
        sa.Column('requires_attachment', sa.Boolean(), server_default=sa.text('0')),
        sa.Column('attachment_category', sa.String(80), nullable=True),
        sa.Column('description', sa.Text(), nullable=True),
        sa.Column('is_active', sa.Boolean(), server_default=sa.text('1')),
        sa.Column('created_at', sa.DateTime(), server_default=sa.func.now()),
    )
    op.create_index('idx_str_module_to', 'state_transition_rules', ['module', 'source_type', 'to_state'])


def downgrade() -> None:
    op.drop_index('idx_str_module_to', table_name='state_transition_rules')
    op.drop_table('state_transition_rules')

    op.drop_constraint('uq_doctpl_name', 'document_templates', type_='unique')
    op.drop_index('idx_doctpl_module', table_name='document_templates')
    op.drop_table('document_templates')

    op.drop_index('idx_fa_sha256', table_name='file_attachments')
    op.drop_index('idx_fa_group', table_name='file_attachments')
    op.drop_column('file_attachments', 'category')
    op.drop_column('file_attachments', 'is_current_version')
    op.drop_column('file_attachments', 'change_note')
    op.drop_column('file_attachments', 'sha256')
    op.drop_column('file_attachments', 'version_number')
    op.drop_column('file_attachments', 'document_group_id')

    op.drop_index('idx_docgroup_category', table_name='document_groups')
    op.drop_index('idx_docgroup_source', table_name='document_groups')
    op.drop_table('document_groups')
