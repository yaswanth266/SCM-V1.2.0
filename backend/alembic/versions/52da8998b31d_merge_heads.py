"""merge_heads

Revision ID: 52da8998b31d
Revises: ab20260516_vendor_categories, fix_item_fields_v2
Create Date: 2026-05-20 11:57:51.447075

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '52da8998b31d'
down_revision: Union[str, Sequence[str], None] = ('ab20260516_vendor_categories', 'fix_item_fields_v2')
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    pass


def downgrade() -> None:
    """Downgrade schema."""
    pass
