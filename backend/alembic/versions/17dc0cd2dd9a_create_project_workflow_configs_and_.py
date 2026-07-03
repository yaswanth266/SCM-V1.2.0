"""create_project_workflow_configs_and_dispatch_custody_transfers

Revision ID: 17dc0cd2dd9a
Revises: 10fa46e83853
Create Date: 2026-06-14 20:16:56.703272

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = '17dc0cd2dd9a'
down_revision: Union[str, Sequence[str], None] = '10fa46e83853'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)

    if not insp.has_table('project_workflow_configs'):
        op.create_table('project_workflow_configs',
        sa.Column('id', sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column('project_id', sa.BigInteger(), nullable=False),
        sa.Column('role_id', sa.BigInteger(), nullable=False),
        sa.Column('indent_approve', sa.Boolean(), nullable=False),
        sa.Column('indent_view', sa.Boolean(), nullable=False),
        sa.Column('dispatch_approve', sa.Boolean(), nullable=False),
        sa.Column('dispatch_view', sa.Boolean(), nullable=False),
        sa.Column('created_at', sa.DateTime(), nullable=True),
        sa.Column('updated_at', sa.DateTime(), nullable=True),
        sa.ForeignKeyConstraint(['project_id'], ['projects.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['role_id'], ['roles.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('project_id', 'role_id', name='uq_project_role_config')
        )

    if not insp.has_table('dispatch_custody_transfers'):
        op.create_table('dispatch_custody_transfers',
        sa.Column('id', sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column('dispatch_order_id', sa.BigInteger(), nullable=False),
        sa.Column('position_id', sa.BigInteger(), nullable=True),
        sa.Column('status', sa.Enum('pending', 'acknowledged', 'skipped', name='custody_status_enum'), nullable=True),
        sa.Column('acknowledged_by_id', sa.BigInteger(), nullable=True),
        sa.Column('acknowledged_at', sa.DateTime(), nullable=True),
        sa.Column('sequence', sa.Integer(), nullable=False),
        sa.ForeignKeyConstraint(['acknowledged_by_id'], ['users.id'], ),
        sa.ForeignKeyConstraint(['dispatch_order_id'], ['dispatch_orders.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['position_id'], ['positions.id'], ondelete='SET NULL'),
        sa.PrimaryKeyConstraint('id')
        )


def downgrade() -> None:
    op.drop_table('dispatch_custody_transfers')
    op.drop_table('project_workflow_configs')
