"""schema drift sync

Revision ID: 2026_07_03_schema_drift_sync
Revises: 8a1c56d19deb
Create Date: 2026-07-03
"""

from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa

revision: str = "2026_07_03_schema_drift_sync"
down_revision: Union[str, Sequence[str], None] = "8a1c56d19deb"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _has_table(inspector, table_name: str) -> bool:
    return table_name in inspector.get_table_names()


def _has_column(inspector, table_name: str, column_name: str) -> bool:
    if not _has_table(inspector, table_name):
        return False
    return any(col["name"] == column_name for col in inspector.get_columns(table_name))


def _has_constraint(inspector, table_name: str, constraint_name: str) -> bool:
    constraints = inspector.get_unique_constraints(table_name)
    constraints += inspector.get_foreign_keys(table_name)
    return any(constraint.get("name") == constraint_name for constraint in constraints)


def upgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)

    # 1. Missing columns
    
    # Table: dispatch_orders
    if _has_table(insp, "dispatch_orders"):
        if not _has_column(insp, "dispatch_orders", "lmdc_code"):
            op.add_column("dispatch_orders", sa.Column("lmdc_code", sa.String(length=50), nullable=True))
        if not _has_column(insp, "dispatch_orders", "trip_sheet_id"):
            op.add_column("dispatch_orders", sa.Column("trip_sheet_id", sa.BigInteger(), nullable=True))

    # Table: logistics_main_dispatch_orders
    if _has_table(insp, "logistics_main_dispatch_orders"):
        if not _has_column(insp, "logistics_main_dispatch_orders", "lmdc_code"):
            op.add_column("logistics_main_dispatch_orders", sa.Column("lmdc_code", sa.String(length=50), nullable=True))
        if not _has_column(insp, "logistics_main_dispatch_orders", "trip_sheet_id"):
            op.add_column("logistics_main_dispatch_orders", sa.Column("trip_sheet_id", sa.BigInteger(), nullable=True))

    # Table: material_issues
    if _has_table(insp, "material_issues"):
        if not _has_column(insp, "material_issues", "trip_sheet_id"):
            op.add_column("material_issues", sa.Column("trip_sheet_id", sa.BigInteger(), nullable=True))

    # Table: indents
    if _has_table(insp, "indents"):
        if not _has_column(insp, "indents", "template_type"):
            op.add_column("indents", sa.Column("template_type", sa.String(length=50), nullable=True))

    # Table: offices
    if _has_table(insp, "offices"):
        if not _has_column(insp, "offices", "parent_office_id"):
            op.add_column("offices", sa.Column("parent_office_id", sa.BigInteger(), nullable=True))
        if not _has_constraint(insp, "offices", "fk_offices_parent_office_id"):
            op.create_foreign_key(
                "fk_offices_parent_office_id",
                "offices",
                "offices",
                ["parent_office_id"],
                ["id"],
                ondelete="SET NULL"
            )

    # Table: vehicles
    if _has_table(insp, "vehicles"):
        if not _has_column(insp, "vehicles", "service_code"):
            op.add_column("vehicles", sa.Column("service_code", sa.String(length=50), nullable=True))

    # Table: items
    if _has_table(insp, "items"):
        if not _has_column(insp, "items", "average_daily_consumption"):
            op.add_column("items", sa.Column("average_daily_consumption", sa.Numeric(precision=15, scale=3), nullable=True))
        if not _has_column(insp, "items", "height_cm"):
            op.add_column("items", sa.Column("height_cm", sa.Numeric(precision=10, scale=2), nullable=True))
        if not _has_column(insp, "items", "length_cm"):
            op.add_column("items", sa.Column("length_cm", sa.Numeric(precision=10, scale=2), nullable=True))
        if not _has_column(insp, "items", "width_cm"):
            op.add_column("items", sa.Column("width_cm", sa.Numeric(precision=10, scale=2), nullable=True))
        if not _has_column(insp, "items", "unit_weight_kg"):
            op.add_column("items", sa.Column("unit_weight_kg", sa.Numeric(precision=10, scale=3), nullable=True))
        if not _has_column(insp, "items", "unit_volume_cm3"):
            op.add_column("items", sa.Column("unit_volume_cm3", sa.Numeric(precision=10, scale=2), nullable=True))
        if not _has_column(insp, "items", "reorder_alert_enabled"):
            op.add_column("items", sa.Column("reorder_alert_enabled", sa.Boolean(), nullable=False, server_default=sa.text("0")))

    # 2. Column definition drift updates
    
    # Table: vehicles
    if _has_table(insp, "vehicles"):
        cols = {col["name"]: col for col in insp.get_columns("vehicles")}
        id_col = cols.get("id")
        if id_col:
            current_type_str = str(id_col["type"]).lower()
            if "bigint" in current_type_str:
                op.execute("ALTER TABLE vehicles MODIFY id INT AUTO_INCREMENT")

        vnum_col = cols.get("vehicle_number")
        if vnum_col:
            vnum_length = getattr(vnum_col["type"], "length", None)
            if vnum_length != 20:
                op.alter_column("vehicles", "vehicle_number", type_=sa.String(length=20), existing_type=vnum_col["type"])

        vcode_col = cols.get("vehicle_code")
        if vcode_col:
            vcode_length = getattr(vcode_col["type"], "length", None)
            if vcode_length != 10:
                op.alter_column("vehicles", "vehicle_code", type_=sa.String(length=10), existing_type=vcode_col["type"])

        created_col = cols.get("created_at")
        if created_col:
            op.alter_column("vehicles", "created_at", server_default=sa.text("CURRENT_TIMESTAMP"), existing_type=created_col["type"])

        updated_col = cols.get("updated_at")
        if updated_col:
            op.execute("ALTER TABLE vehicles MODIFY updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP")

    # Table: indent_acknowledgements
    if _has_table(insp, "indent_acknowledgements"):
        cols = {col["name"]: col for col in insp.get_columns("indent_acknowledgements")}
        ack_col = cols.get("acknowledged_at")
        if ack_col:
            op.alter_column("indent_acknowledgements", "acknowledged_at", nullable=False, server_default=None, existing_type=ack_col["type"])

    # Table: dispatch_delivery_acknowledgements
    if _has_table(insp, "dispatch_delivery_acknowledgements"):
        cols = {col["name"]: col for col in insp.get_columns("dispatch_delivery_acknowledgements")}
        phone_col = cols.get("acknowledged_by_phone")
        if phone_col and phone_col["nullable"]:
            op.alter_column("dispatch_delivery_acknowledgements", "acknowledged_by_phone", nullable=False, existing_type=phone_col["type"])

    # Table: logistics_sdo_destinations
    if _has_table(insp, "logistics_sdo_destinations"):
        cols = {col["name"]: col for col in insp.get_columns("logistics_sdo_destinations")}
        mobile_col = cols.get("delivery_contact_mobile")
        if mobile_col and mobile_col["nullable"]:
            op.alter_column("logistics_sdo_destinations", "delivery_contact_mobile", nullable=False, existing_type=mobile_col["type"])


def downgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)

    # 1. Revert Column Definition Updates
    # Table: logistics_sdo_destinations
    if _has_table(insp, "logistics_sdo_destinations"):
        cols = {col["name"]: col for col in insp.get_columns("logistics_sdo_destinations")}
        mobile_col = cols.get("delivery_contact_mobile")
        if mobile_col and not mobile_col["nullable"]:
            op.alter_column("logistics_sdo_destinations", "delivery_contact_mobile", nullable=True, existing_type=mobile_col["type"])

    # Table: dispatch_delivery_acknowledgements
    if _has_table(insp, "dispatch_delivery_acknowledgements"):
        cols = {col["name"]: col for col in insp.get_columns("dispatch_delivery_acknowledgements")}
        phone_col = cols.get("acknowledged_by_phone")
        if phone_col and not phone_col["nullable"]:
            op.alter_column("dispatch_delivery_acknowledgements", "acknowledged_by_phone", nullable=True, existing_type=phone_col["type"])

    # Table: indent_acknowledgements
    if _has_table(insp, "indent_acknowledgements"):
        cols = {col["name"]: col for col in insp.get_columns("indent_acknowledgements")}
        ack_col = cols.get("acknowledged_at")
        if ack_col:
            op.alter_column("indent_acknowledgements", "acknowledged_at", nullable=True, server_default=sa.text("CURRENT_TIMESTAMP"), existing_type=ack_col["type"])

    # Table: vehicles
    if _has_table(insp, "vehicles"):
        cols = {col["name"]: col for col in insp.get_columns("vehicles")}
        
        op.execute("ALTER TABLE vehicles MODIFY updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP")
        
        created_col = cols.get("created_at")
        if created_col:
            op.alter_column("vehicles", "created_at", server_default=sa.text("now()"), existing_type=created_col["type"])
            
        vcode_col = cols.get("vehicle_code")
        if vcode_col:
            op.alter_column("vehicles", "vehicle_code", type_=sa.String(length=50), existing_type=vcode_col["type"])

        vnum_col = cols.get("vehicle_number")
        if vnum_col:
            op.alter_column("vehicles", "vehicle_number", type_=sa.String(length=50), existing_type=vnum_col["type"])

        id_col = cols.get("id")
        if id_col:
            op.execute("ALTER TABLE vehicles MODIFY id BIGINT AUTO_INCREMENT")

    # 2. Revert Missing Columns
    # Table: items
    if _has_table(insp, "items"):
        for col_name in ["reorder_alert_enabled", "unit_volume_cm3", "unit_weight_kg", "width_cm", "length_cm", "height_cm", "average_daily_consumption"]:
            if _has_column(insp, "items", col_name):
                op.drop_column("items", col_name)

    # Table: vehicles
    if _has_table(insp, "vehicles"):
        if _has_column(insp, "vehicles", "service_code"):
            op.drop_column("vehicles", "service_code")

    # Table: offices
    if _has_table(insp, "offices"):
        if _has_constraint(insp, "offices", "fk_offices_parent_office_id"):
            op.drop_constraint("fk_offices_parent_office_id", "offices", type_="foreignkey")
        if _has_column(insp, "offices", "parent_office_id"):
            op.drop_column("offices", "parent_office_id")

    # Table: indents
    if _has_table(insp, "indents"):
        if _has_column(insp, "indents", "template_type"):
            op.drop_column("indents", "template_type")

    # Table: material_issues
    if _has_table(insp, "material_issues"):
        if _has_column(insp, "material_issues", "trip_sheet_id"):
            op.drop_column("material_issues", "trip_sheet_id")

    # Table: logistics_main_dispatch_orders
    if _has_table(insp, "logistics_main_dispatch_orders"):
        if _has_column(insp, "logistics_main_dispatch_orders", "trip_sheet_id"):
            op.drop_column("logistics_main_dispatch_orders", "trip_sheet_id")
        if _has_column(insp, "logistics_main_dispatch_orders", "lmdc_code"):
            op.drop_column("logistics_main_dispatch_orders", "lmdc_code")

    # Table: dispatch_orders
    if _has_table(insp, "dispatch_orders"):
        if _has_column(insp, "dispatch_orders", "trip_sheet_id"):
            op.drop_column("dispatch_orders", "trip_sheet_id")
        if _has_column(insp, "dispatch_orders", "lmdc_code"):
            op.drop_column("dispatch_orders", "lmdc_code")
