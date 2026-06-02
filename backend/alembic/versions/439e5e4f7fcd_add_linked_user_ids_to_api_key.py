"""add linked_user_ids to api_key

Revision ID: 439e5e4f7fcd
Revises: 1f3629f1ca12
Create Date: 2026-05-21 16:03:13.879970

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import mysql

# revision identifiers, used by Alembic.
revision: str = '439e5e4f7fcd'
down_revision: Union[str, Sequence[str], None] = '1f3629f1ca12'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    pass

def downgrade() -> None:
    with op.batch_alter_table('api_keys', schema=None) as batch_op:
        batch_op.drop_column('linked_user_ids')
