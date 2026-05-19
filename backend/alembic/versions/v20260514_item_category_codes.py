"""add item category short and full codes

Revision ID: v20260514_item_category_codes
Revises: u20260514_specs_master
Create Date: 2026-05-14
"""
from alembic import op
import sqlalchemy as sa


revision = "v20260514_item_category_codes"
down_revision = "u20260514_specs_master"
branch_labels = None
depends_on = None


def _derive_short(category, siblings):
    for raw in (category.get("code_prefix"), category.get("code")):
        text = str(raw or "")
        for idx in range(0, max(len(text) - 1, 0)):
            chunk = text[idx:idx + 2]
            if chunk.isdigit() and 10 <= int(chunk) <= 99:
                return chunk
    parent_id = category.get("parent_id")
    ordered = sorted(siblings.get(parent_id, []), key=lambda row: ((row.get("name") or ""), row["id"]))
    for pos, row in enumerate(ordered, start=10):
        if row["id"] == category["id"]:
            return f"{pos:02d}" if pos <= 99 else None
    return None


def upgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    columns = {col["name"] for col in insp.get_columns("item_categories")}

    if "short_code" not in columns:
        op.add_column("item_categories", sa.Column("short_code", sa.String(length=2), nullable=True))
    if "full_code" not in columns:
        op.add_column("item_categories", sa.Column("full_code", sa.String(length=6), nullable=True))

    rows = [
        dict(row._mapping)
        for row in bind.execute(
            sa.text("SELECT id, parent_id, name, code, code_prefix FROM item_categories ORDER BY parent_id, name, id")
        )
    ]
    by_id = {row["id"]: row for row in rows}
    siblings = {}
    for row in rows:
        siblings.setdefault(row.get("parent_id"), []).append(row)
    for row in rows:
        row["short_code"] = _derive_short(row, siblings)

    def full_code(row):
        if row.get("full_code"):
            return row["full_code"]
        if not row.get("short_code"):
            row["full_code"] = None
            return row["full_code"]
        parent_id = row.get("parent_id")
        if parent_id and parent_id in by_id and full_code(by_id[parent_id]):
            row["full_code"] = f"{full_code(by_id[parent_id])}{row['short_code']}"[:6]
        elif parent_id:
            row["full_code"] = None
        else:
            row["full_code"] = row["short_code"]
        return row["full_code"]

    used = set()
    for row in rows:
        code = full_code(row)
        if code and code in used:
            suffix = 10
            base = code[:-2] if len(code) > 2 else ""
            while f"{base}{suffix:02d}" in used and suffix <= 99:
                suffix += 1
            if suffix <= 99:
                code = f"{base}{suffix:02d}"
                row["short_code"] = code[-2:]
                row["full_code"] = code
            else:
                row["short_code"] = None
                row["full_code"] = None
        if row["full_code"]:
            used.add(row["full_code"])
        bind.execute(
            sa.text("UPDATE item_categories SET short_code = :short_code, full_code = :full_code WHERE id = :id"),
            {"id": row["id"], "short_code": row["short_code"], "full_code": row["full_code"]},
        )

    indexes = {idx["name"] for idx in insp.get_indexes("item_categories")}
    if "ix_item_categories_parent_short_code" not in indexes:
        op.create_index(
            "ix_item_categories_parent_short_code",
            "item_categories",
            ["parent_id", "short_code"],
            unique=True,
        )
    if "ix_item_categories_full_code" not in indexes:
        op.create_index("ix_item_categories_full_code", "item_categories", ["full_code"], unique=True)


def downgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    indexes = {idx["name"] for idx in insp.get_indexes("item_categories")}
    if "ix_item_categories_full_code" in indexes:
        op.drop_index("ix_item_categories_full_code", table_name="item_categories")
    if "ix_item_categories_parent_short_code" in indexes:
        op.drop_index("ix_item_categories_parent_short_code", table_name="item_categories")
    columns = {col["name"] for col in insp.get_columns("item_categories")}
    if "full_code" in columns:
        op.drop_column("item_categories", "full_code")
    if "short_code" in columns:
        op.drop_column("item_categories", "short_code")
