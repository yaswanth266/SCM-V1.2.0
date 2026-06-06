"""Add readable category and item codes

Revision ID: ab20260606_read_codes
Revises: ab20260606_item_is_kit
Create Date: 2026-06-06
"""
from alembic import op
import sqlalchemy as sa
import re
import unicodedata


revision = "ab20260606_read_codes"
down_revision = "ab20260606_item_is_kit"
branch_labels = None
depends_on = None


def _has_column(inspector, table_name: str, column_name: str) -> bool:
    return any(col.get("name") == column_name for col in inspector.get_columns(table_name))


def _has_index(inspector, table_name: str, index_name: str) -> bool:
    return any(idx.get("name") == index_name for idx in inspector.get_indexes(table_name))


def _token(value, max_len=None):
    raw = (value or "").strip()
    if not raw:
        token = "GEN"
    else:
        ascii_value = unicodedata.normalize("NFKD", raw).encode("ascii", "ignore").decode("ascii")
        token = re.sub(r"[^A-Z0-9]+", "-", ascii_value.upper()).strip("-") or "GEN"
    return token[:max_len] if max_len else token


def _category_code(name, code):
    cleaned = re.sub(r"-\d{3,}$", "", (code or "").strip().upper())
    if cleaned and not re.fullmatch(r"\d+", cleaned):
        return cleaned
    return _token(name, 3)


def upgrade():
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    if not _has_column(inspector, "items", "readable_code"):
        op.add_column("items", sa.Column("readable_code", sa.String(length=255), nullable=True))
        inspector = sa.inspect(bind)

    categories = [dict(row._mapping) for row in bind.execute(sa.text(
        "SELECT id, parent_id, name, code FROM item_categories ORDER BY parent_id, name, id"
    ))]
    used_category_codes = set()
    for cat in categories:
        base = _category_code(cat.get("name"), cat.get("code"))
        attempt = base
        suffix_ord = ord("A")
        while attempt in used_category_codes:
            attempt = f"{base}{chr(suffix_ord)}"
            suffix_ord += 1
        used_category_codes.add(attempt)
        cat["code"] = attempt
        bind.execute(sa.text("UPDATE item_categories SET code = :code WHERE id = :id"), cat)

    by_id = {int(cat["id"]): cat for cat in categories}

    def chain(category_id):
        parts = []
        current = by_id.get(int(category_id)) if category_id else None
        seen = set()
        while current and int(current["id"]) not in seen:
            seen.add(int(current["id"]))
            parts.append(current["code"])
            current = by_id.get(int(current["parent_id"])) if current.get("parent_id") else None
        return list(reversed(parts)) or ["GEN"]

    items = [dict(row._mapping) for row in bind.execute(sa.text(
        "SELECT id, category_id, name FROM items ORDER BY id"
    ))]
    used_item_codes = set()
    for item in items:
        base = "-".join([*chain(item.get("category_id")), _token(item.get("name"))])
        attempt = base
        suffix_ord = ord("A")
        while attempt in used_item_codes:
            attempt = f"{base}-{chr(suffix_ord)}"
            suffix_ord += 1
        used_item_codes.add(attempt)
        bind.execute(
            sa.text("UPDATE items SET readable_code = :readable_code WHERE id = :id"),
            {"id": item["id"], "readable_code": attempt},
        )

    if not _has_index(inspector, "items", "ix_items_readable_code"):
        op.create_index("ix_items_readable_code", "items", ["readable_code"], unique=True)


def downgrade():
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if _has_index(inspector, "items", "ix_items_readable_code"):
        op.drop_index("ix_items_readable_code", table_name="items")
    if _has_column(inspector, "items", "readable_code"):
        op.drop_column("items", "readable_code")
