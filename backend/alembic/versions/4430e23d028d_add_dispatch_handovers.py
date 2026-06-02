"""add_dispatch_handovers

Revision ID: 4430e23d028d
Revises: aa20260527_add_with_vehicle_to_quotations
Create Date: 2026-05-28 11:32:08.333502

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '4430e23d028d'
down_revision: Union[str, Sequence[str], None] = 'aa20260527_add_with_vehicle_to_quotations'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    pass


def downgrade() -> None:
    """Downgrade schema."""
    pass
