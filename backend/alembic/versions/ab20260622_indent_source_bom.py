"""Add source BOM reference to indents

Revision ID: ab20260622_indent_bom
Revises: ab20260616_uw_role
Create Date: 2026-06-22
"""
from alembic import op
import sqlalchemy as sa


revision = "ab20260622_indent_bom"
down_revision = "ab20260616_uw_role"
branch_labels = None
depends_on = None


def _has_column(inspector, table_name: str, column_name: str) -> bool:
    return any(col.get("name") == column_name for col in inspector.get_columns(table_name))


def _has_fk(inspector, table_name: str, fk_name: str) -> bool:
    return any(fk.get("name") == fk_name for fk in inspector.get_foreign_keys(table_name))


def _has_index(inspector, table_name: str, index_name: str) -> bool:
    return any(idx.get("name") == index_name for idx in inspector.get_indexes(table_name))


def upgrade():
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if not _has_column(inspector, "indents", "source_bom_id"):
        op.add_column("indents", sa.Column("source_bom_id", sa.BigInteger(), nullable=True))
        op.create_foreign_key("fk_indents_source_bom", "indents", "boms", ["source_bom_id"], ["id"])
    inspector = sa.inspect(bind)
    if not _has_index(inspector, "indents", "idx_indents_source_bom"):
        op.create_index("idx_indents_source_bom", "indents", ["source_bom_id"])


def downgrade():
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if _has_index(inspector, "indents", "idx_indents_source_bom"):
        op.drop_index("idx_indents_source_bom", table_name="indents")
    if _has_fk(inspector, "indents", "fk_indents_source_bom"):
        op.drop_constraint("fk_indents_source_bom", "indents", type_="foreignkey")
    if _has_column(inspector, "indents", "source_bom_id"):
        op.drop_column("indents", "source_bom_id")
