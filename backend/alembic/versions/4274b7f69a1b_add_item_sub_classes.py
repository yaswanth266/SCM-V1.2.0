"""add_item_sub_classes

Revision ID: 4274b7f69a1b
Revises: 2026_07_03_mi_item_trace_fields
Create Date: 2026-07-04 12:46:14.640632

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '4274b7f69a1b'
down_revision: Union[str, Sequence[str], None] = '2026_07_03_mi_item_trace_fields'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema.
    
    Database schema updates are handled dynamically at application startup 
    via app/utils/schema_sync.py (ensure_item_sub_classes_schema).
    This migration acts as a version marker to satisfy Alembic.
    """
    pass


def downgrade() -> None:
    """Downgrade schema."""
    pass
