"""
Audit: find Pydantic XxxCreate schema fields that do NOT exist on the matching
SQLAlchemy model / DB table.

This is the class of bug that caused 'remarks is an invalid keyword argument for
TransportRequirement' today. The Pydantic schema accepts a field the backend
code then tries to pass to a model constructor, but the DB column / model
attribute doesn't exist.
"""
import importlib
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from pydantic import BaseModel
from sqlalchemy.orm import DeclarativeBase

SCHEMA_MODULES = [
    "app.schemas.auth", "app.schemas.master", "app.schemas.indent",
    "app.schemas.procurement", "app.schemas.warehouse", "app.schemas.inventory",
    "app.schemas.logistics", "app.schemas.accounts", "app.schemas.consumption",
    "app.schemas.healthcare",
]
MODEL_MODULES = [
    "app.models.user", "app.models.master", "app.models.indent",
    "app.models.procurement", "app.models.warehouse", "app.models.grn",
    "app.models.stock", "app.models.transfer", "app.models.logistics",
    "app.models.accounts", "app.models.consumption", "app.models.healthcare",
    "app.models.asset", "app.models.audit", "app.models.returns",
    "app.models.outbound", "app.models.dispatch", "app.models.issue",
    "app.models.approval", "app.models.barcode", "app.models.system",
]


def load_models():
    """Return {tablename: set(column_names)} for every SQLAlchemy model."""
    tables = {}
    for mod_name in MODEL_MODULES:
        try:
            mod = importlib.import_module(mod_name)
        except Exception as e:
            print(f"  [warn] cannot import {mod_name}: {e}")
            continue
        for name in dir(mod):
            cls = getattr(mod, name)
            if (
                isinstance(cls, type)
                and hasattr(cls, "__tablename__")
                and hasattr(cls, "__table__")
            ):
                tables[cls.__tablename__] = (cls.__name__, {c.name for c in cls.__table__.columns})
    return tables


def load_schemas():
    """Return [(schema_class_name, set(field_names))] for every BaseModel."""
    schemas = []
    for mod_name in SCHEMA_MODULES:
        try:
            mod = importlib.import_module(mod_name)
        except Exception as e:
            print(f"  [warn] cannot import {mod_name}: {e}")
            continue
        for name in dir(mod):
            cls = getattr(mod, name)
            if (
                isinstance(cls, type)
                and issubclass(cls, BaseModel)
                and cls is not BaseModel
            ):
                fields = set(cls.model_fields.keys())
                schemas.append((name, fields))
    return schemas


def guess_tablename(schema_name: str, tables: dict):
    """Map SchemaClassName -> table. Try exact, strip suffixes, try plural."""
    base = schema_name
    for suffix in ("Create", "Update", "Response", "Detail", "Out", "In"):
        if base.endswith(suffix):
            base = base[: -len(suffix)]
    # pascal -> snake
    snake = ""
    for i, ch in enumerate(base):
        if ch.isupper() and i > 0:
            snake += "_" + ch.lower()
        else:
            snake += ch.lower()
    candidates = [snake, snake + "s", snake + "es"]
    # rewrite common irregulars
    if snake.endswith("y"):
        candidates.append(snake[:-1] + "ies")
    for c in candidates:
        if c in tables:
            return c
    return None


def main():
    tables = load_models()
    print(f"Loaded {len(tables)} models")
    schemas = load_schemas()
    print(f"Loaded {len(schemas)} Pydantic schemas\n")

    # Noise fields — these are frontend aliases we don't expect in the DB
    NOISE = {
        "items", "documents", "attachments", "transport_requirement_id",
        "vehicle_availability", "destination", "convert_to", "notify",
    }

    drifts = []
    for schema_name, fields in schemas:
        if not schema_name.endswith("Create"):
            continue
        tbl = guess_tablename(schema_name, tables)
        if not tbl:
            continue
        model_name, cols = tables[tbl]
        missing = (fields - cols) - NOISE
        if missing:
            drifts.append((schema_name, model_name, tbl, sorted(missing)))

    print(f"=== {len(drifts)} schema/model drifts found ===\n")
    for schema, model, tbl, missing in drifts:
        print(f"{schema} -> {model} ({tbl}):")
        for f in missing:
            print(f"    missing: {f}")
        print()


if __name__ == "__main__":
    main()
