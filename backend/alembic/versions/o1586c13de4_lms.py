"""LMS — tutorial videos shown to each role on login.

Revision ID: o1586c13de4
Revises: n1475b12cd3
Create Date: 2026-04-25
"""
from alembic import op
import sqlalchemy as sa


revision = 'o1586c13de4'
down_revision = 'n1475b12cd3'
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    if not insp.has_table("lms_videos"):
        op.create_table(
            "lms_videos",
            sa.Column("id", sa.BigInteger, primary_key=True, autoincrement=True),
            sa.Column("code", sa.String(80), nullable=False, unique=True),
            sa.Column("title", sa.String(255), nullable=False),
            sa.Column("description", sa.Text),
            # CSV of role codes that should see this video.
            # 'all' means every authenticated user sees it.
            sa.Column("role_codes", sa.String(500), nullable=False, server_default="all"),
            sa.Column("video_url", sa.String(500), nullable=False),
            sa.Column("duration_seconds", sa.Integer),
            sa.Column("sort_order", sa.Integer, server_default="0"),
            sa.Column("module", sa.String(80)),  # 'indent','procurement','warehouse',...
            sa.Column("is_active", sa.Boolean, server_default=sa.text("1")),
            sa.Column(
                "created_at", sa.DateTime, server_default=sa.text("CURRENT_TIMESTAMP")
            ),
        )


def downgrade() -> None:
    try:
        op.drop_table("lms_videos")
    except Exception:
        pass
