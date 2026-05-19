"""
Compare every SQLAlchemy model's columns against the live DB table columns.
Print any column defined in the model but missing in the DB — these will
cause OperationalError -> 503 on every SELECT.
"""
import importlib
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import asyncio
from sqlalchemy import text
from app.database import engine

MODEL_MODULES = [
    "app.models.user", "app.models.master", "app.models.indent",
    "app.models.procurement", "app.models.warehouse", "app.models.grn",
    "app.models.stock", "app.models.transfer", "app.models.logistics",
    "app.models.accounts", "app.models.consumption", "app.models.healthcare",
    "app.models.asset", "app.models.audit", "app.models.returns",
    "app.models.outbound", "app.models.dispatch", "app.models.issue",
    "app.models.approval", "app.models.barcode", "app.models.system",
]


async def main():
    tables = {}
    for mod_name in MODEL_MODULES:
        try:
            mod = importlib.import_module(mod_name)
        except Exception as e:
            print(f"  [warn] {mod_name}: {e}")
            continue
        for name in dir(mod):
            cls = getattr(mod, name)
            if (
                isinstance(cls, type)
                and hasattr(cls, "__tablename__")
                and hasattr(cls, "__table__")
            ):
                tables[cls.__tablename__] = (cls.__name__, {c.name for c in cls.__table__.columns})

    async with engine.connect() as conn:
        mismatches = []
        for tbl_name, (cls_name, model_cols) in sorted(tables.items()):
            try:
                result = await conn.execute(text(f"SHOW COLUMNS FROM `{tbl_name}`"))
                db_cols = {row[0] for row in result.fetchall()}
            except Exception as e:
                print(f"[ERR] cannot inspect {tbl_name}: {e}")
                continue
            missing_in_db = model_cols - db_cols
            if missing_in_db:
                mismatches.append((tbl_name, cls_name, sorted(missing_in_db)))

    print(f"\n=== {len(mismatches)} models reference columns that do not exist in DB ===\n")
    for tbl, cls, cols in mismatches:
        print(f"{cls} ({tbl}):")
        for c in cols:
            print(f"    SELECT will FAIL on: {c}")
        print()

    # Emit ALTER statements to fix them (user reviews before running)
    print("\n=== Suggested DDL (review before running) ===\n")
    type_hints = {
        "attachment_url": "VARCHAR(500) NULL",
        "remarks": "TEXT NULL",
        "created_at": "DATETIME NULL DEFAULT CURRENT_TIMESTAMP",
        "updated_at": "DATETIME NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP",
        "description": "TEXT NULL",
    }
    for tbl, cls, cols in mismatches:
        for c in cols:
            ddl = type_hints.get(c, "TEXT NULL")
            print(f"ALTER TABLE `{tbl}` ADD COLUMN `{c}` {ddl};")


if __name__ == "__main__":
    asyncio.run(main())
