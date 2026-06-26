from fastapi import APIRouter, Depends, HTTPException, status, Query
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, update, delete, func, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import selectinload, joinedload
from datetime import datetime, timezone, date, timedelta
from typing import List, Dict, Any, Optional

from app.database import get_db
from app.utils.dependencies import get_current_user
from app.models.user import User
from app.models.master import Item, Vendor
from app.models.warehouse import Warehouse
from app.models.system import Notification, ActivityLog, NumberSeries
from app.models.logistics import (
    LogisticsLocation, LogisticsRoute, LogisticsRouteLocation, LogisticsLoadingBay,
    LogisticsMainDispatchOrder, LogisticsSubDispatchOrder, LogisticsSdoDestination,
    LogisticsDispatchMaterial, LogisticsRfqMaster, LogisticsRfqDispatchMapping,
    LogisticsRfqVendor, LogisticsRfqResponse, LogisticsRfqResponseVehicle,
    LogisticsRfqResponseSdoAssignment, LogisticsServiceOrder, LogisticsServiceOrderVehicle,
    LogisticsServiceOrderSdoMapping, DispatchHandover
)
from app.models.carrier import CarrierUser
from app.schemas.carrier_auth import (
    CarrierCreate, CarrierUpdate, CarrierLoginCreate, CarrierLoginUpdate,
)
from app.services.auth_service import hash_password
from app.utils.dependencies import require_any_role
from app.schemas.logistics import (
    LocationSchema, RouteSchema, LoadingBaySchema,
    MdoCreate, MdoResponse, SdoResponse, SdoDestinationResponse, DispatchMaterialResponse,
    RfqCreateSchema, RfqResponse, RfqVendorResponse, RfqResponseQuoteResponse, RfqResponseVehicleResponse, SdoAssignmentResponse,
    QuoteSubmit, DeclineRfqInvitation, AwardRfqQuote,
    ServiceOrderResponse, ServiceOrderVehicleResponse, ServiceOrderSdoMappingResponse,
    SoAcknowledge, VehicleStatusUpdate, VehicleIssueLog,
    DispatchHandoverCreate, DispatchHandoverResponse, DispatchHandoverVerifyOtp,
    SdoHandoverSchema, SdoReceiveSchema
)

router = APIRouter()


async def generate_logistics_sequence_number(
    db: AsyncSession,
    *,
    prefix: str,
    document_type: str,
) -> str:
    year = str(date.today().year)
    result = await db.execute(
        select(NumberSeries)
        .where(
            NumberSeries.module == "logistics",
            NumberSeries.document_type == document_type,
            NumberSeries.fiscal_year == year,
        )
        .with_for_update()
    )
    series = result.scalar_one_or_none()

    if not series:
        series = NumberSeries(
            prefix=prefix,
            module="logistics",
            document_type=document_type,
            fiscal_year=year,
            current_number=0,
            pad_length=7,
            org_prefix="",
            format_template=f"{prefix}-{{fy}}-{{seq}}",
        )
        db.add(series)
        try:
            async with db.begin_nested():
                await db.flush()
        except IntegrityError:
            db.expunge(series)
            result = await db.execute(
                select(NumberSeries)
                .where(
                    NumberSeries.module == "logistics",
                    NumberSeries.document_type == document_type,
                    NumberSeries.fiscal_year == year,
                )
                .with_for_update()
            )
            series = result.scalar_one()

    new_num = (series.current_number or 0) + 1
    series.current_number = new_num
    series.prefix = prefix
    if document_type == "main_dispatch_order":
        series.pad_length = 10
        series.format_template = "DO-BHSPL-{fy}-{seq}"
    else:
        if not series.pad_length or series.pad_length < 7:
            series.pad_length = 7
        series.format_template = f"{prefix}-{{fy}}-{{seq}}"
    await db.flush()

    seq = str(new_num).zfill(series.pad_length or 7)
    today = date.today()
    if today.month >= 4:
        fy_start = today.year
    else:
        fy_start = today.year - 1
    fy_end = fy_start + 1
    fy_str = f"FY{str(fy_start)[2:]}-{str(fy_end)[2:]}"

    fy_val = fy_str if document_type == "main_dispatch_order" else year

    return (
        series.format_template
        .replace("{fy}", fy_val)
        .replace("{seq}", seq)
        .replace("{type}", prefix)
        .replace("{org}", "")
    )

# --- AUTOMATIC BOOTSTRAP PROCESS ---

async def ensure_logistics_schema(db: AsyncSession):
    conn = await db.connection()
    await conn.run_sync(LogisticsLocation.__table__.create, checkfirst=True)
    await conn.run_sync(LogisticsRoute.__table__.create, checkfirst=True)
    await conn.run_sync(LogisticsRouteLocation.__table__.create, checkfirst=True)
    await conn.run_sync(LogisticsLoadingBay.__table__.create, checkfirst=True)
    await conn.run_sync(LogisticsMainDispatchOrder.__table__.create, checkfirst=True)
    await conn.run_sync(LogisticsSubDispatchOrder.__table__.create, checkfirst=True)
    await conn.run_sync(LogisticsSdoDestination.__table__.create, checkfirst=True)
    await conn.run_sync(LogisticsDispatchMaterial.__table__.create, checkfirst=True)
    await conn.run_sync(LogisticsRfqMaster.__table__.create, checkfirst=True)
    await conn.run_sync(LogisticsRfqDispatchMapping.__table__.create, checkfirst=True)
    await conn.run_sync(LogisticsRfqVendor.__table__.create, checkfirst=True)
    await conn.run_sync(LogisticsRfqResponse.__table__.create, checkfirst=True)
    await conn.run_sync(LogisticsRfqResponseVehicle.__table__.create, checkfirst=True)
    await conn.run_sync(LogisticsRfqResponseSdoAssignment.__table__.create, checkfirst=True)
    await conn.run_sync(LogisticsServiceOrder.__table__.create, checkfirst=True)
    await conn.run_sync(LogisticsServiceOrderVehicle.__table__.create, checkfirst=True)
    await conn.run_sync(LogisticsServiceOrderSdoMapping.__table__.create, checkfirst=True)
    # Carrier portal users (login accounts for transport carriers)
    await conn.run_sync(CarrierUser.__table__.create, checkfirst=True)
    # Explicitly register DispatchHandover to prevent setup/creation issues
    await conn.run_sync(DispatchHandover.__table__.create, checkfirst=True)

    async def add_column_if_not_exists(table: str, col: str, definition: str):
        exists = (await conn.execute(text(f"""
            SELECT 1 FROM information_schema.columns 
            WHERE table_schema = DATABASE() 
              AND table_name = '{table}' 
              AND column_name = '{col}'
            LIMIT 1
        """))).scalar_one_or_none()
        if not exists:
            try:
                await conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {col} {definition}"))
            except Exception as ex:
                print(f"[SCM Schema Sync] Failed to add column {col} to {table}: {ex}")

    # Add columns to logistics_main_dispatch_orders
    await add_column_if_not_exists("logistics_main_dispatch_orders", "dispatch_mode", "VARCHAR(50) NOT NULL DEFAULT 'direct'")
    await add_column_if_not_exists("logistics_main_dispatch_orders", "destination_user_id", "BIGINT NULL")

    # Add columns to logistics_sub_dispatch_orders
    await add_column_if_not_exists("logistics_sub_dispatch_orders", "custodian_position_id", "BIGINT NULL")
    await add_column_if_not_exists("logistics_sub_dispatch_orders", "sequence_number", "INT NOT NULL DEFAULT 1")
    await add_column_if_not_exists("logistics_sub_dispatch_orders", "handover_type", "VARCHAR(50) NULL")
    await add_column_if_not_exists("logistics_sub_dispatch_orders", "handed_over_by_id", "BIGINT NULL")
    await add_column_if_not_exists("logistics_sub_dispatch_orders", "handover_time", "DATETIME NULL")
    await add_column_if_not_exists("logistics_sub_dispatch_orders", "carrier_details", "JSON NULL")
    await add_column_if_not_exists("logistics_sub_dispatch_orders", "received_by_id", "BIGINT NULL")
    await add_column_if_not_exists("logistics_sub_dispatch_orders", "received_at", "DATETIME NULL")
    await add_column_if_not_exists("logistics_sub_dispatch_orders", "seal_intact", "TINYINT(1) NULL")
    await add_column_if_not_exists("logistics_sub_dispatch_orders", "packaging_condition", "VARCHAR(50) NULL")
    await add_column_if_not_exists("logistics_sub_dispatch_orders", "discrepancy_reported", "TINYINT(1) NULL")
    await add_column_if_not_exists("logistics_sub_dispatch_orders", "receiving_remarks", "TEXT NULL")
    await add_column_if_not_exists("logistics_sub_dispatch_orders", "handover_photos", "JSON NULL")
    await add_column_if_not_exists("logistics_sub_dispatch_orders", "handover_signature", "VARCHAR(500) NULL")
    await add_column_if_not_exists("logistics_sub_dispatch_orders", "receipt_photos", "JSON NULL")
    await add_column_if_not_exists("logistics_sub_dispatch_orders", "receipt_signature", "VARCHAR(500) NULL")

    # Modify logistics_sub_dispatch_orders status column type from Enum to VARCHAR (safe upgrade)
    # Must handle the case where the column is an ENUM that doesn't include all needed values.
    try:
        # First check if the column is still an ENUM type
        col_type_res = await conn.execute(text("""
            SELECT DATA_TYPE, COLUMN_TYPE
            FROM information_schema.columns
            WHERE table_schema = DATABASE()
              AND table_name = 'logistics_sub_dispatch_orders'
              AND column_name = 'status'
        """))
        col_info = col_type_res.one_or_none()
        if col_info and col_info[0] == 'enum':
            # Column is still ENUM — convert to VARCHAR(50)
            await conn.execute(text(
                "ALTER TABLE logistics_sub_dispatch_orders MODIFY COLUMN status VARCHAR(50) NOT NULL DEFAULT 'PENDING'"
            ))
            print("[SCM Schema Sync] Converted logistics_sub_dispatch_orders.status from ENUM to VARCHAR(50)")
    except Exception as ex:
        print(f"[SCM Schema Sync] Failed to alter status type: {ex}")
        # Fallback: try direct alter anyway
        try:
            await conn.execute(text(
                "ALTER TABLE logistics_sub_dispatch_orders MODIFY COLUMN status VARCHAR(50) NOT NULL DEFAULT 'PENDING'"
            ))
        except Exception:
            pass

    # Modify logistics_dispatch_materials sdo_id to nullable
    try:
        await conn.execute(text("ALTER TABLE logistics_dispatch_materials MODIFY COLUMN sdo_id BIGINT NULL"))
    except Exception as ex:
        print(f"[SCM Schema Sync] Failed to alter sdo_id in logistics_dispatch_materials to nullable: {ex}")

    # Dynamic SCM enum updates for MySQL
    # Convert MDO status to VARCHAR(50) to support dynamic AT_* statuses
    # (e.g. AT_REGIONAL_MANAGER, AT_DISTRICT_MANAGER set during custody chain)
    try:
        col_type_res = await conn.execute(text("""
            SELECT DATA_TYPE FROM information_schema.columns
            WHERE table_schema = DATABASE()
              AND table_name = 'logistics_main_dispatch_orders'
              AND column_name = 'status'
        """))
        col_info = col_type_res.one_or_none()
        if col_info and col_info[0] == 'enum':
            await conn.execute(text(
                "ALTER TABLE logistics_main_dispatch_orders "
                "MODIFY COLUMN status VARCHAR(50) NOT NULL DEFAULT 'DRAFT'"
            ))
            print("[SCM Schema Sync] Converted logistics_main_dispatch_orders.status from ENUM to VARCHAR(50)")
    except Exception as e:
        print(f"[SCM Schema Sync] Failed to convert MDO status to VARCHAR: {e}")
        try:
            await conn.execute(text(
                "ALTER TABLE logistics_main_dispatch_orders "
                "MODIFY COLUMN status VARCHAR(50) NOT NULL DEFAULT 'DRAFT'"
            ))
        except Exception:
            pass

    try:
        # Step 1: Temporarily expand ENUM to union of old & new values
        await conn.execute(text("""
            ALTER TABLE logistics_service_orders 
            MODIFY COLUMN status ENUM('CREATED', 'ACKNOWLEDGED', 'ACCEPTED', 'REJECTED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED') 
            NOT NULL DEFAULT 'CREATED'
        """))
        # Step 2: Migrate ACKNOWLEDGED -> ACCEPTED
        await conn.execute(text("UPDATE logistics_service_orders SET status = 'ACCEPTED' WHERE status = 'ACKNOWLEDGED'"))
        # Step 3: Restrict to new ENUM values only
        await conn.execute(text("""
            ALTER TABLE logistics_service_orders 
            MODIFY COLUMN status ENUM('CREATED', 'ACCEPTED', 'REJECTED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED') 
            NOT NULL DEFAULT 'CREATED'
        """))
    except Exception as e:
        print(f"[SCM Schema Sync] Skipping service order status alter or already applied: {e}")

    try:
        # Step 1: Temporarily expand ENUM to union of old & new values
        await conn.execute(text("""
            ALTER TABLE logistics_service_order_vehicles 
            MODIFY COLUMN vehicle_status ENUM('SCHEDULED', 'ARRIVED', 'GATE_IN', 'LOADING', 'DISPATCHED', 'GATE_OUT', 'IN_TRANSIT', 'TRANSPORTER_ACKNOWLEDGED', 'DELIVERED', 'DELIVERY_ACKNOWLEDGED', 'CANCELLED') 
            NOT NULL DEFAULT 'SCHEDULED'
        """))
        # Step 2: Migrate old values to new equivalents
        await conn.execute(text("UPDATE logistics_service_order_vehicles SET vehicle_status = 'GATE_IN' WHERE vehicle_status = 'ARRIVED'"))
        await conn.execute(text("UPDATE logistics_service_order_vehicles SET vehicle_status = 'GATE_OUT' WHERE vehicle_status = 'DISPATCHED'"))
        await conn.execute(text("UPDATE logistics_service_order_vehicles SET vehicle_status = 'DELIVERY_ACKNOWLEDGED' WHERE vehicle_status = 'DELIVERED'"))
        # Step 3: Restrict to new ENUM values only
        await conn.execute(text("""
            ALTER TABLE logistics_service_order_vehicles 
            MODIFY COLUMN vehicle_status ENUM('SCHEDULED', 'GATE_IN', 'LOADING', 'GATE_OUT', 'IN_TRANSIT', 'TRANSPORTER_ACKNOWLEDGED', 'DELIVERY_ACKNOWLEDGED', 'CANCELLED') 
            NOT NULL DEFAULT 'SCHEDULED'
        """))
    except Exception as e:
        print(f"[SCM Schema Sync] Skipping vehicle status alter or already applied: {e}")



async def bootstrap_logistics_data(db: AsyncSession):
    # Ensure logistics tables are created dynamically
    await ensure_logistics_schema(db)

    # Check if locations already exist
    res = await db.execute(select(func.count(LogisticsLocation.id)))
    count = res.scalar() or 0
    if count > 0:
        return

    print("Bootstrapping Logistics Module Master Data...")

    # 1. Seed Locations
    locations = [
        LogisticsLocation(
            location_code="LOC-THANE-DIST",
            location_name="Thane Central Receiving Depot",
            location_type="BRANCH",
            address_line1="Industrial Sector 5, Kolshet Road",
            city="Thane",
            state="Maharashtra",
            pincode="400607",
            latitude=19.2183,
            longitude=72.9781,
            contact_person="Vikram Phadnis",
            mobile="+919822110033",
            email="thane.depot@company.com",
            delivery_instructions="Gate 2 has a physical height constraint of 4.5m."
        ),
        LogisticsLocation(
            location_code="LOC-NASHIK-SUP",
            location_name="Nashik Secondary Storage Yard",
            location_type="WAREHOUSE",
            address_line1="Ambad GIDC, Plot No. A-21, Bombay Road",
            city="Nashik",
            state="Maharashtra",
            pincode="422010",
            latitude=19.9975,
            longitude=73.7898,
            contact_person="Mrs. Smita Holkar",
            mobile="+919866112233",
            email="nashik.yard@company.com",
            delivery_instructions="Forklift driver departs at 18:00. Inform 2 hours prior."
        ),
        LogisticsLocation(
            location_code="LOC-VALSAD-FAC",
            location_name="Valsad Polymer Finishing Plant",
            location_type="OTHER",
            address_line1="Dharampur Road, Industrial Zone Sector 3",
            city="Valsad",
            state="Gujarat",
            pincode="396001",
            latitude=20.6100,
            longitude=72.9300,
            contact_person="Harish Bhai",
            mobile="+919898001122",
            email="valsad.plant@company.com",
            delivery_instructions="Ramp loading is mandatory. Wear safety helmets."
        ),
        LogisticsLocation(
            location_code="LOC-PUNE-WEST",
            location_name="Pune West Delivery Point",
            location_type="CUSTOMER",
            address_line1="Hinjawadi Phase 3, Infotech High Road",
            city="Pune",
            state="Maharashtra",
            pincode="411057",
            latitude=18.5913,
            longitude=73.7183,
            contact_person="Arjun Sen",
            mobile="+919156003312",
            email="pune.west@customer-alliance.org",
            delivery_instructions="Enter via Security gate 4."
        )
    ]
    for loc in locations:
        db.add(loc)
    await db.flush()

    # Get active warehouses to map routes
    res = await db.execute(select(Warehouse))
    warehouses = res.scalars().all()
    wh_id = warehouses[0].id if warehouses else 1

    # 2. Seed Routes
    routes = [
        LogisticsRoute(
            route_code="RTE-MUM-NSH",
            route_name="Mumbai Central - Thane - Nashik Express Route",
            origin_warehouse_id=wh_id,
            estimated_distance_km=175.50,
            estimated_duration_hours=4.50,
            terrain_type="MIXED",
            recommended_vehicle_type="Truck"
        ),
        LogisticsRoute(
            route_code="RTE-MUM-PUN",
            route_name="Mumbai - Pune Expressway Corridor",
            origin_warehouse_id=wh_id,
            estimated_distance_km=145.00,
            estimated_duration_hours=3.20,
            terrain_type="HIGHWAY",
            recommended_vehicle_type="Container"
        ),
        LogisticsRoute(
            route_code="RTE-PUN-GUJ",
            route_name="Pune - Valsad - Surat Inter-State Gateway",
            origin_warehouse_id=wh_id,
            estimated_distance_km=360.00,
            estimated_duration_hours=8.50,
            terrain_type="HIGHWAY",
            recommended_vehicle_type="Truck"
        )
    ]
    for r in routes:
        db.add(r)
    await db.flush()

    # 3. Seed Route Locations mapping
    route_locs = [
        LogisticsRouteLocation(route_id=routes[0].id, location_id=locations[0].id, sequence_number=1, distance_from_previous_km=28.50, estimated_time_minutes=45),
        LogisticsRouteLocation(route_id=routes[0].id, location_id=locations[1].id, sequence_number=2, distance_from_previous_km=147.00, estimated_time_minutes=225),
        LogisticsRouteLocation(route_id=routes[1].id, location_id=locations[3].id, sequence_number=1, distance_from_previous_km=145.00, estimated_time_minutes=192),
        LogisticsRouteLocation(route_id=routes[2].id, location_id=locations[2].id, sequence_number=1, distance_from_previous_km=265.00, estimated_time_minutes=360),
    ]
    for rl in route_locs:
        db.add(rl)

    # 4. Seed Loading Bays
    bays = [
        LogisticsLoadingBay(warehouse_id=wh_id, bay_number="BAY-M-01", bay_name="North Loading Dock - Heavy Cranes", max_vehicle_type="Flatbed Container", is_covered=True, has_dock_leveler=True, has_forklift=True),
        LogisticsLoadingBay(warehouse_id=wh_id, bay_number="BAY-M-02", bay_name="Medium Dock - Regular Container", max_vehicle_type="Container", is_covered=True, has_dock_leveler=True, has_forklift=True),
        LogisticsLoadingBay(warehouse_id=wh_id, bay_number="BAY-M-03", bay_name="South Bay Shop - Tempo Dock", max_vehicle_type="Tempo", is_covered=False, has_dock_leveler=False, has_forklift=False),
    ]
    for b in bays:
        db.add(b)

    # 5. Seed Transport Carriers in standard vendors table if missing
    carriers_data = [
        ("VND-PHOENIX-00", "Phoenix Logistics & Freight", "Mr. Satish Kelkar", "bids@phoenixexpress.com", "9811223344", 4.8),
        ("VND-SPEEDBOT-22", "SpeedBot Premium Haulers", "Ms. Meera Johar", "meera.j@speedbotshipping.co.in", "9845322110", 4.5),
        ("VND-TRISTATE-15", "Tri-State Logistics Solutions", "Mr. Baldev Singh", "operations@tristatecarriers.in", "9322115599", 4.2),
        ("VND-MARUTI-99", "Maruti Cargo Logistics", "Mr. Rajesh Rawat", "info@maruticargo.com", "9112233990", 3.9),
    ]
    for code, name, contact, email, phone, rating in carriers_data:
        res_v = await db.execute(select(Vendor).where(Vendor.vendor_code == code).limit(1))
        existing_vendor = res_v.scalar_one_or_none()
        if not existing_vendor:
            new_v = Vendor(
                vendor_code=code,
                name=name,
                contact_person=contact,
                email=email,
                phone=phone,
                rating=rating,
                is_transport_vendor=True,
                vendor_type="transport",
                is_active=True
            )
            db.add(new_v)

    # 6. Seed some default items for logistics if items table is empty
    res_items = await db.execute(select(func.count(Item.id)))
    if (res_items.scalar() or 0) == 0:
        default_item = Item(
            item_code="MAT-STEEL-001",
            name="High-Tensile Industrial Steel Rods (10m)",
            description="Structural reinforcement carbon steel rods.",
            item_type="material",
            primary_uom_id=1,
            is_active=True
        )
        db.add(default_item)

    await db.flush()
    print("Logistics Master Data bootstrapped successfully.")

# --- API ENDPOINTS ---

@router.get("/masters")
async def get_logistics_masters(db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user)):
    # Locations
    res_loc = await db.execute(select(LogisticsLocation).where(LogisticsLocation.is_active == True))
    locations = res_loc.scalars().all()

    # Routes
    res_rte = await db.execute(select(LogisticsRoute).where(LogisticsRoute.is_active == True))
    routes = res_rte.scalars().all()

    # Route locations
    res_rl = await db.execute(select(LogisticsRouteLocation).options(joinedload(LogisticsRouteLocation.location)))
    route_locs = res_rl.scalars().all()

    # Bays
    res_bay = await db.execute(select(LogisticsLoadingBay).where(LogisticsLoadingBay.is_active == True))
    bays = res_bay.scalars().all()

    # Carriers (Vendors with is_transport_vendor=True)
    res_carr = await db.execute(select(Vendor).where((Vendor.is_transport_vendor == True) | (Vendor.vendor_type == "transport")))
    carriers = res_carr.scalars().all()

    # Materials
    res_mat = await db.execute(select(Item).where(Item.is_active == True).limit(200))
    materials = res_mat.scalars().all()

    # Warehouses
    res_wh = await db.execute(select(Warehouse).where(Warehouse.is_active == True))
    warehouses = res_wh.scalars().all()

    return {
        "locations": [LocationSchema.model_validate(l) for l in locations],
        "routes": [RouteSchema.model_validate(r) for r in routes],
        "routeLocations": [
            {
                "id": rl.id,
                "route_id": rl.route_id,
                "location_id": rl.location_id,
                "sequence_number": rl.sequence_number,
                "distance_from_previous_km": float(rl.distance_from_previous_km),
                "estimated_time_minutes": rl.estimated_time_minutes,
                "location_name": rl.location.location_name if rl.location else None
            }
            for rl in route_locs
        ],
        "loadingBays": [LoadingBaySchema.model_validate(b) for b in bays],
        "carriers": [
            {
                "vendor_id": c.id,
                "vendor_code": c.vendor_code,
                "vendor_name": c.name,
                "contact_person": c.contact_person,
                "mobile": c.phone,
                "email": c.email,
                "rating": float(c.rating or 0.0),
                "vehicle_types_available": ["Truck", "Container", "Tempo"]
            }
            for c in carriers
        ],
        "materials": [
            {
                "material_id": m.id,
                "material_code": m.item_code,
                "material_name": m.name,
                "category": m.item_type,
                "unit_of_measure": "PCS",
                "weight_per_unit": 45.0,
                "volume_per_unit": 3.5
            }
            for m in materials
        ],
        "warehouses": [
            {
                "warehouse_id": w.id,
                "warehouse_code": w.code,
                "warehouse_name": w.name
            }
            for w in warehouses
        ]
    }

@router.get("/dashboard")
async def get_logistics_dashboard(db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user)):
    # Active counts
    draft_mdo = (await db.execute(select(func.count(LogisticsMainDispatchOrder.id)).where(LogisticsMainDispatchOrder.status == "DRAFT"))).scalar() or 0
    open_rfq = (await db.execute(select(func.count(LogisticsRfqMaster.id)).where(LogisticsRfqMaster.status == "PUBLISHED"))).scalar() or 0
    active_so = (await db.execute(select(func.count(LogisticsServiceOrder.id)).where(LogisticsServiceOrder.status == "IN_PROGRESS"))).scalar() or 0
    unread_notif = (await db.execute(select(func.count(Notification.id)).where(Notification.user_id == current_user.id, Notification.is_read == False))).scalar() or 0

    return {
        "stats": {
            "draftMdos": draft_mdo,
            "openRfqs": open_rfq,
            "activeSos": active_so,
            "unreadNotifications": unread_notif
        }
    }

@router.get("/mdo", response_model=List[MdoResponse])
async def get_mdos(db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user)):
    # Resolve user's position for SDO-based filtering
    from app.models.settings_master import Employee as MdoEmployee
    user_position_id = None
    if current_user.employee_id:
        emp_res = await db.execute(select(MdoEmployee).where(MdoEmployee.id == current_user.employee_id))
        emp = emp_res.scalar_one_or_none()
        if emp and emp.position_id:
            user_position_id = emp.position_id
    
    # Admin/super_admin bypass position filter
    from app.utils.dependencies import get_user_role_codes
    role_codes = set(await get_user_role_codes(db, current_user.id))
    is_admin = bool({"super_admin", "admin"} & role_codes)
    
    query = (
        select(LogisticsMainDispatchOrder)
        .options(
            selectinload(LogisticsMainDispatchOrder.sdos).joinedload(LogisticsSubDispatchOrder.custodian_position),
            selectinload(LogisticsMainDispatchOrder.sdos).joinedload(LogisticsSubDispatchOrder.handed_over_by),
            selectinload(LogisticsMainDispatchOrder.sdos).joinedload(LogisticsSubDispatchOrder.received_by),
            selectinload(LogisticsMainDispatchOrder.materials).joinedload(LogisticsDispatchMaterial.material),
            selectinload(LogisticsMainDispatchOrder.handover).joinedload(DispatchHandover.transporter),
            joinedload(LogisticsMainDispatchOrder.warehouse),
            joinedload(LogisticsMainDispatchOrder.destination_user),
            joinedload(LogisticsMainDispatchOrder.creator),
            joinedload(LogisticsMainDispatchOrder.indent),
            joinedload(LogisticsMainDispatchOrder.material_issue)
        )
    )
    
    # Filter by user position in SDO custody chain (non-admin users)
    if user_position_id and not is_admin:
        from app.models.settings_master import Position as MdoPosition

        # Collect ALL positions this employee holds
        all_employee_positions_res = await db.execute(
            select(MdoPosition.id).where(MdoPosition.employee_id == current_user.employee_id)
        )
        all_pos_ids = set(all_employee_positions_res.scalars().all())
        all_pos_ids.add(user_position_id)

        # PERF-FIX: Load ALL positions in ONE query, then resolve descendants in-memory.
        # The old approach called get_position_descendants() per position, each of which
        # did a BFS loop firing one DB query per tree node — O(N) round-trips.
        all_positions_res = await db.execute(
            select(MdoPosition.id, MdoPosition.parent_position_id)
        )
        # Build child map: parent_id -> [child_ids]
        child_map: dict = {}
        for pos_id, parent_id in all_positions_res.all():
            if parent_id is not None:
                child_map.setdefault(parent_id, []).append(pos_id)

        # BFS in-memory to collect all descendants of the user's positions
        allowed_position_ids = set(all_pos_ids)
        queue = list(all_pos_ids)
        while queue:
            curr = queue.pop(0)
            for child_id in child_map.get(curr, []):
                if child_id not in allowed_position_ids:
                    allowed_position_ids.add(child_id)
                    queue.append(child_id)

        from sqlalchemy import or_
        from app.models.user import UserWarehouse as DbUserWarehouse
        from app.models.settings_master import Employee as DbEmployee
        from app.utils.dependencies import user_warehouse_ids as _user_wh_ids

        # Resolve the warehouses the current user is mapped to (for origin-warehouse visibility)
        user_whs = await _user_wh_ids(db, current_user.id)

        # Condition for SDO-based dispatches (multi-level):
        cond_sdo = LogisticsMainDispatchOrder.id.in_(
            select(LogisticsSubDispatchOrder.mdo_id)
            .where(LogisticsSubDispatchOrder.custodian_position_id.in_(allowed_position_ids))
        )

        # Condition for direct dispatches via destination user:
        cond_direct_user = (
            LogisticsMainDispatchOrder.dispatch_mode.ilike("direct") &
            LogisticsMainDispatchOrder.destination_user_id.in_(
                select(User.id)
                .join(DbEmployee, User.employee_id == DbEmployee.id)
                .where(DbEmployee.position_id.in_(allowed_position_ids))
            )
        )

        # Condition for direct dispatches via destination warehouse:
        cond_direct_wh = (
            LogisticsMainDispatchOrder.dispatch_mode.ilike("direct") &
            LogisticsMainDispatchOrder.destination_warehouse_id.in_(
                select(DbUserWarehouse.warehouse_id)
                .join(User, User.id == DbUserWarehouse.user_id)
                .join(DbEmployee, User.employee_id == DbEmployee.id)
                .where(DbEmployee.position_id.in_(allowed_position_ids))
            )
        )

        # Condition for MDOs originating from the user's own warehouse (creator/storekeeper view):
        cond_origin = (
            LogisticsMainDispatchOrder.warehouse_id.in_(user_whs)
            if user_whs else False
        )

        # Condition for MDOs created directly by this user:
        cond_creator = (LogisticsMainDispatchOrder.created_by == current_user.id)

        query = query.where(or_(cond_sdo, cond_direct_user, cond_direct_wh, cond_origin, cond_creator))
    
    query = query.order_by(LogisticsMainDispatchOrder.id.desc())
    res = await db.execute(query)
    mdos = res.scalars().all()

    from app.models.dispatch import DispatchOrder
    mdo_numbers = [m.mdo_number for m in mdos if m.mdo_number]
    dispatch_map = {}
    if mdo_numbers:
        dispatch_res = await db.execute(
            select(DispatchOrder).where(DispatchOrder.dispatch_number.in_(mdo_numbers))
        )
        dispatch_map = {d.dispatch_number: d for d in dispatch_res.scalars().all()}

    output = []
    for m in mdos:
        d_order = dispatch_map.get(m.mdo_number)
        m_dict = MdoResponse(
            id=m.id,
            mdo_number=m.mdo_number,
            customer_reference=m.customer_reference,
            order_reference=m.order_reference,
            warehouse_id=m.warehouse_id,
            warehouse_name=m.warehouse.name if m.warehouse else None,
            order_date=m.order_date,
            required_delivery_date=m.required_delivery_date,
            total_material_items=m.total_material_items,
            total_weight_kg=float(m.total_weight_kg),
            total_volume_cft=float(m.total_volume_cft),
            total_value=float(m.total_value),
            special_instructions=m.special_instructions,
            priority=m.priority.name if hasattr(m.priority, "name") else m.priority,
            status=m.status.name if hasattr(m.status, "name") else m.status,
            created_by=m.created_by,
            creator_name=m.creator.username if m.creator else "System",
            approved_by=m.approved_by,
            approved_at=m.approved_at,
            created_at=m.created_at,
            updated_at=m.updated_at,
            material_issue_id=m.material_issue_id,
            material_issue_number=m.material_issue.issue_number if m.material_issue else None,
            indent_id=m.indent_id,
            indent_number=m.indent.indent_number if m.indent else None,
            destination_warehouse_id=m.destination_warehouse_id,
            destination_user_id=m.destination_user_id,
            destination_user_name=m.destination_user.username if m.destination_user else None,
            delivery_address=m.delivery_address,
            e_challan=m.e_challan,
            waybill=m.waybill,
            dispatch_type=m.dispatch_type,
            dispatch_mode=m.dispatch_mode,
            handover=m.handover,
            delivery_acknowledged=d_order.delivery_acknowledged if d_order else False,
            delivery_acknowledged_at=d_order.delivery_acknowledged_at if d_order else None,
            delivery_acknowledged_by_name=d_order.delivery_acknowledged_by_name if d_order else None,
            delivery_acknowledged_by_phone=d_order.delivery_acknowledged_by_phone if d_order else None,
            receiver_signature_url=d_order.receiver_signature_url if d_order else None,
            delivery_photo_urls=d_order.delivery_photo_urls if d_order else None,
            goods_condition_on_delivery=d_order.goods_condition_on_delivery.name if (d_order and hasattr(d_order.goods_condition_on_delivery, "name")) else (str(d_order.goods_condition_on_delivery) if (d_order and d_order.goods_condition_on_delivery) else None),
            delivery_remarks=d_order.delivery_remarks if d_order else None,
            sdos=[],
            materials=[]
        )

        for mat in m.materials:
            m_dict.materials.append(
                DispatchMaterialResponse(
                    id=mat.id,
                    mdo_id=mat.mdo_id,
                    sdo_id=mat.sdo_id,
                    material_id=mat.material_id,
                    material_code=mat.material.item_code if mat.material else None,
                    material_name=mat.material.name if mat.material else None,
                    quantity=float(mat.quantity),
                    unit_of_measure=mat.unit_of_measure,
                    total_weight_kg=float(mat.total_weight_kg),
                    total_volume_cft=float(mat.total_volume_cft),
                    unit_price=float(mat.unit_price),
                    total_value=float(mat.total_value),
                    batch_number=mat.batch_number,
                    serial_numbers=mat.serial_numbers,
                    number_of_packages=mat.number_of_packages,
                    package_type=mat.package_type,
                    handling_instructions=mat.handling_instructions,
                    special_storage_condition=mat.material.special_storage_condition if mat.material else False,
                    storage_min_temp=float(mat.material.storage_min_temp) if (mat.material and mat.material.storage_min_temp is not None) else None,
                    storage_max_temp=float(mat.material.storage_max_temp) if (mat.material and mat.material.storage_max_temp is not None) else None,
                    storage_min_moisture=float(mat.material.storage_min_moisture) if (mat.material and mat.material.storage_min_moisture is not None) else None,
                    storage_max_moisture=float(mat.material.storage_max_moisture) if (mat.material and mat.material.storage_max_moisture is not None) else None,
                    storage_breakable=mat.material.storage_breakable if mat.material else False,
                    special_transport_condition=mat.material.special_transport_condition if mat.material else False,
                    transport_min_temp=float(mat.material.transport_min_temp) if (mat.material and mat.material.transport_min_temp is not None) else None,
                    transport_max_temp=float(mat.material.transport_max_temp) if (mat.material and mat.material.transport_max_temp is not None) else None,
                    transport_min_moisture=float(mat.material.transport_min_moisture) if (mat.material and mat.material.transport_min_moisture is not None) else None,
                    transport_max_moisture=float(mat.material.transport_max_moisture) if (mat.material and mat.material.transport_max_moisture is not None) else None,
                    transport_breakable=mat.material.transport_breakable if mat.material else False
                )
            )

        for s in m.sdos:
            s_dict = SdoResponse(
                id=s.id,
                sdo_number=s.sdo_number,
                mdo_id=s.mdo_id,
                route_id=s.route_id,
                route_name=s.route_name,
                vehicle_type_required=s.vehicle_type_required,
                estimated_weight_kg=float(s.estimated_weight_kg),
                estimated_volume_cft=float(s.estimated_volume_cft),
                estimated_distance_km=float(s.estimated_distance_km),
                loading_time_minutes=s.loading_time_minutes,
                unloading_time_minutes=s.unloading_time_minutes,
                requires_loading_helper=s.requires_loading_helper,
                special_requirements=s.special_requirements,
                status=s.status,
                created_at=s.created_at,
                destinations=[],
                materials=[],
                custodian_position_id=s.custodian_position_id,
                custodian_position_name=s.custodian_position.name if s.custodian_position else None,
                sequence_number=s.sequence_number,
                handover_type=s.handover_type,
                handed_over_by_id=s.handed_over_by_id,
                handed_over_by_name=s.handed_over_by.username if s.handed_over_by else None,
                handover_time=s.handover_time,
                carrier_details=s.carrier_details,
                received_by_id=s.received_by_id,
                received_by_name=s.received_by.username if s.received_by else None,
                received_at=s.received_at,
                seal_intact=s.seal_intact,
                packaging_condition=s.packaging_condition,
                discrepancy_reported=s.discrepancy_reported,
                receiving_remarks=s.receiving_remarks,
                handover_photos=s.handover_photos,
                handover_signature=s.handover_signature,
                receipt_photos=s.receipt_photos,
                receipt_signature=s.receipt_signature
            )
            m_dict.sdos.append(s_dict)
        output.append(m_dict)

    return output


async def resolve_mdo_project_id(db: AsyncSession, indent_id: Optional[int], material_issue_id: Optional[int]) -> Optional[int]:
    from app.models.indent import Indent
    from app.models.issue import MaterialIssue
    if indent_id:
        res = await db.execute(select(Indent.project_id).where(Indent.id == indent_id))
        p_id = res.scalar_one_or_none()
        if p_id:
            return p_id
    if material_issue_id:
        res = await db.execute(select(MaterialIssue).where(MaterialIssue.id == material_issue_id))
        mi = res.scalar_one_or_none()
        if mi and mi.indent_id:
            res2 = await db.execute(select(Indent.project_id).where(Indent.id == mi.indent_id))
            return res2.scalar_one_or_none()
    return None


async def resolve_indent_creator_position(db: AsyncSession, indent_id, material_issue_id):
    """Resolve the indent creator's position for chain building."""
    from app.models.indent import Indent
    from app.models.issue import MaterialIssue
    from app.models.settings_master import Employee
    
    indent_obj = None
    if indent_id:
        res = await db.execute(select(Indent).where(Indent.id == indent_id))
        indent_obj = res.scalar_one_or_none()
    if not indent_obj and material_issue_id:
        res = await db.execute(select(MaterialIssue).where(MaterialIssue.id == material_issue_id))
        mi = res.scalar_one_or_none()
        if mi and mi.indent_id:
            res2 = await db.execute(select(Indent).where(Indent.id == mi.indent_id))
            indent_obj = res2.scalar_one_or_none()
    if not indent_obj:
        return None
    
    user_res = await db.execute(select(User).where(User.id == indent_obj.raised_by))
    user_obj = user_res.scalar_one_or_none()
    if user_obj and user_obj.employee_id:
        emp_res = await db.execute(select(Employee).where(Employee.id == user_obj.employee_id))
        emp = emp_res.scalar_one_or_none()
        if emp and emp.position_id:
            return emp.position_id
    return None


async def build_logistics_custody_chain(
    db: AsyncSession,
    project_id: int,
    starting_position_id: int,
    dest_pos_id = None,
) -> list:
    """Build custody chain from starting position walking UP parents.

    Returns a list of entries ordered top-down (highest in hierarchy first):
      {position, can_approve, can_view, view_only, is_destination}

    IMPORTANT: Only positions with dispatch_approve=True generate actual SDO custody
    legs. Positions with only dispatch_view=True are 'observers' — they appear in
    the visual hierarchy display but are SKIPPED during SDO creation so custody
    never gets stuck at a view-only role (e.g. OE).
    The destination position is always appended last as is_destination=True.
    """
    from app.models.settings_master import Position
    from app.models.approval import ProjectWorkflowConfig
    from app.services.approval_service import get_position_ancestors

    ancestors = await get_position_ancestors(db, starting_position_id)
    chain = []
    for pos in ancestors:
        if not pos.role_id:
            continue
        cfg_q = await db.execute(
            select(ProjectWorkflowConfig).where(
                ProjectWorkflowConfig.project_id == project_id,
                ProjectWorkflowConfig.role_id == pos.role_id
            )
        )
        cfg = cfg_q.scalar_one_or_none()
        if cfg and (cfg.dispatch_approve or cfg.dispatch_view):
            chain.append({
                "position": pos,
                "can_approve": bool(cfg.dispatch_approve),
                "can_view": bool(cfg.dispatch_view),
                # view_only positions are included for display but skipped for SDO creation
                "view_only": bool(cfg.dispatch_view) and not bool(cfg.dispatch_approve),
            })

    chain.reverse()

    if dest_pos_id and (not chain or chain[-1]["position"].id != dest_pos_id):
        dest_res = await db.execute(select(Position).where(Position.id == dest_pos_id))
        dest_pos = dest_res.scalar_one_or_none()
        if dest_pos:
            chain.append({
                "position": dest_pos,
                "can_approve": False,
                "can_view": False,
                "view_only": False,
                "is_destination": True,
            })

    return chain



@router.get("/preview-dispatch-chain")
async def preview_dispatch_chain(
    material_issue_id: int = Query(...),
    destination_warehouse_id = Query(None),
    destination_user_id = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Preview the multi-level dispatch chain before creating MDO."""
    from app.models.issue import MaterialIssue
    from app.models.settings_master import Position, Employee
    from app.api.v1.dispatch import get_destination_position_id
    
    mi_res = await db.execute(select(MaterialIssue).where(MaterialIssue.id == material_issue_id))
    mi = mi_res.scalar_one_or_none()
    if not mi:
        raise HTTPException(404, "Material Issue not found")
    
    wh_res = await db.execute(select(Warehouse).where(Warehouse.id == mi.warehouse_id))
    wh = wh_res.scalar_one_or_none()
    source_warehouse_name = wh.name if wh else "Unknown Warehouse"
    
    dest_pos_id = await get_destination_position_id(db, destination_warehouse_id, destination_user_id)
    project_id = await resolve_mdo_project_id(db, mi.indent_id, material_issue_id)
    starting_pos_id = await resolve_indent_creator_position(db, mi.indent_id, material_issue_id)
    
    if not project_id or not starting_pos_id:
        return {
            "source_warehouse": source_warehouse_name,
            "chain": [],
            "message": "Could not resolve project or starting position."
        }
    
    chain = await build_logistics_custody_chain(db, project_id, starting_pos_id, dest_pos_id)
    
    out = []
    for entry in chain:
        pos = entry["position"]
        emp_name = None
        emp_code = None
        if pos.employee_id:
            emp_res = await db.execute(select(Employee).where(Employee.id == pos.employee_id))
            emp = emp_res.scalar_one_or_none()
            if emp:
                emp_name = emp.name or ""
                emp_code = emp.employee_code
        
        role_name = pos.role_name
        role_code = ""
        if pos.role_id:
            from app.models.user import Role
            role_q = await db.execute(select(Role).where(Role.id == pos.role_id))
            role_obj = role_q.scalar_one_or_none()
            if role_obj:
                role_name = role_obj.name
                role_code = role_obj.code
        
        out.append({
            "position_id": pos.id,
            "position_name": pos.name,
            "role_name": role_name,
            "role_code": role_code,
            "employee_name": emp_name,
            "employee_code": emp_code,
            "can_approve": entry.get("can_approve", False),
            "can_view": entry.get("can_view", False),
            "view_only": entry.get("view_only", False),
            "is_destination": entry.get("is_destination", False),
        })
    
    return {
        "source_warehouse": source_warehouse_name,
        "starting_position_id": starting_pos_id,
        "project_id": project_id,
        "chain": out,
    }


@router.post("/mdo")
async def create_mdo(payload: MdoCreate, db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user)):
    mdo_num = await generate_logistics_sequence_number(
        db,
        prefix="DO",
        document_type="main_dispatch_order",
    )

    tot_items = 0
    tot_weight = 0.0
    tot_volume = 0.0
    tot_value = 0.0

    if payload.dispatch_type != "THIRD_PARTY":
        if (payload.dispatch_type or "").lower() in ("own vehicle", "courier", "in_person"):
            initial_status = "IN_TRANSIT"
        else:
            initial_status = "DISPATCHED"
    else:
        initial_status = "DRAFT"
    first_delivery_date = date.today() + timedelta(days=2)

    for mat in payload.materials:
        tot_items += 1
        wt = mat.qty * 10.0
        vol = mat.qty * 0.5
        val = mat.qty * 1200.0
        tot_weight += wt
        tot_volume += vol
        tot_value += val

    dest_user_id = payload.destination_user_id
    if not dest_user_id and payload.indent_id:
        from app.models.indent import Indent
        indent_res = await db.execute(select(Indent).where(Indent.id == payload.indent_id))
        ind_obj = indent_res.scalar_one_or_none()
        if ind_obj:
            dest_user_id = ind_obj.raised_by

    new_mdo = LogisticsMainDispatchOrder(
        mdo_number=mdo_num,
        warehouse_id=payload.warehouseId,
        priority=payload.priority,
        special_instructions=payload.specialInstructions,
        order_date=date.today(),
        required_delivery_date=first_delivery_date,
        created_by=current_user.id,
        status=initial_status,
        material_issue_id=payload.material_issue_id,
        indent_id=payload.indent_id,
        destination_warehouse_id=payload.destination_warehouse_id,
        destination_user_id=dest_user_id,
        delivery_address=payload.delivery_address,
        e_challan=payload.e_challan,
        waybill=payload.waybill,
        dispatch_type=payload.dispatch_type or "THIRD_PARTY",
        dispatch_mode=payload.dispatch_mode or "direct"
    )
    db.add(new_mdo)
    await db.flush()

    if payload.dispatch_type != "THIRD_PARTY":
        handover_num = await generate_logistics_sequence_number(
            db,
            prefix="HND",
            document_type="handover",
        )
        new_handover = DispatchHandover(
            dispatch_id=new_mdo.id,
            handover_no=handover_num,
            handover_type=payload.dispatch_type,
            handed_over_by_entity_id=current_user.id,
            received_by_name=payload.received_by_name or "Carrier Receiver",
            received_by_phone=payload.received_by_phone,
            vehicle_no=payload.vehicle_no,
            driver_name=payload.driver_name,
            driver_phone=payload.driver_phone,
            courier_name=payload.courier_name,
            awb_no=payload.awb_no,
            remarks=payload.handover_remarks,
            status="HANDED_OVER",
            handover_time=datetime.now(timezone.utc)
        )
        db.add(new_handover)
        await db.flush()

    for mat in payload.materials:
        wt = mat.qty * 10.0
        vol = mat.qty * 0.5
        val = mat.qty * 1200.0
        new_mat = LogisticsDispatchMaterial(
            mdo_id=new_mdo.id,
            sdo_id=None,
            material_id=mat.materialId,
            quantity=mat.qty,
            unit_of_measure="PCS",
            total_weight_kg=wt,
            total_volume_cft=vol,
            unit_price=1200.0,
            total_value=val,
            batch_number=mat.batchNo or "B2026-AUTO",
            number_of_packages=mat.pkgCount,
            package_type=mat.pkgType,
            handling_instructions=mat.instructions
        )
        db.add(new_mat)
    await db.flush()

    dispatch_mode = (payload.dispatch_mode or "direct").lower()
    from app.api.v1.dispatch import get_destination_position_id
    dest_pos_id = await get_destination_position_id(db, payload.destination_warehouse_id, dest_user_id)

    chain_data = []
    if dispatch_mode == "multi-level":
        project_id = await resolve_mdo_project_id(db, payload.indent_id, payload.material_issue_id)
        starting_pos_id = await resolve_indent_creator_position(db, payload.indent_id, payload.material_issue_id)
        if project_id and starting_pos_id:
            chain_data = await build_logistics_custody_chain(db, project_id, starting_pos_id, dest_pos_id)

    chain = [entry["position"] for entry in chain_data if entry.get("can_approve", False) or entry.get("is_destination", False)]

    if dispatch_mode == "multi-level":
        if chain:
            # Only create the first SDO (Leg 1)
            pos = chain[0]
            sdo_num = await generate_logistics_sequence_number(
                db,
                prefix="SDO",
                document_type="sub_dispatch_order",
            )
            new_sdo = LogisticsSubDispatchOrder(
                sdo_number=sdo_num,
                mdo_id=new_mdo.id,
                route_id=None,
                route_name="Custody Leg 1",
                vehicle_type_required="Truck",
                estimated_distance_km=100.0,
                required_pickup_datetime=datetime.now(timezone.utc),
                required_delivery_datetime=datetime.now(timezone.utc) + timedelta(days=2),
                loading_time_minutes=30,
                unloading_time_minutes=30,
                requires_loading_helper=False,
                status="PENDING",
                custodian_position_id=pos.id,
                sequence_number=1,
                estimated_weight_kg=tot_weight,
                estimated_volume_cft=tot_volume
            )
            db.add(new_sdo)
        else:
            sdo_num = await generate_logistics_sequence_number(
                db,
                prefix="SDO",
                document_type="sub_dispatch_order",
            )
            new_sdo = LogisticsSubDispatchOrder(
                sdo_number=sdo_num,
                mdo_id=new_mdo.id,
                route_id=None,
                route_name="Direct Custody Leg",
                vehicle_type_required="Truck",
                estimated_distance_km=100.0,
                required_pickup_datetime=datetime.now(timezone.utc),
                required_delivery_datetime=datetime.now(timezone.utc) + timedelta(days=2),
                loading_time_minutes=30,
                unloading_time_minutes=30,
                requires_loading_helper=False,
                status="PENDING",
                custodian_position_id=dest_pos_id,
                sequence_number=1,
                estimated_weight_kg=tot_weight,
                estimated_volume_cft=tot_volume
            )
            db.add(new_sdo)

    new_mdo.total_material_items = tot_items
    new_mdo.total_weight_kg = tot_weight
    new_mdo.total_volume_cft = tot_volume
    new_mdo.total_value = tot_value
    db.add(new_mdo)

    # INVENTORY: At MDO creation, convert source reserved_qty → transit_qty.
    #
    # CENTRAL WAREHOUSE (parent_id IS NULL): Stock was reserved via issue_material().
    # At dispatch plan creation, convert reserved→transit:
    #   - reserved_qty drops to 0 (goods committed to dispatch)
    #   - transit_qty rises by qty (goods tracked as in-flight)
    #   - total_qty UNCHANGED (physically still at CEN until destination acknowledges)
    #   - available_qty stays 0 (already excluded by reservation)
    #
    # MULTI-LEVEL (other warehouses): Same reserved→transit conversion applies.
    #
    # DIRECT DISPATCH (other warehouses): Not applicable — process_dispatch_stock_deduction
    # handles deduction separately.
    #
    # IMPORTANT: Only convert if reserved_qty > 0 (i.e. issue_material was called first).
    # Never blindly set transit from qty — that caused premature transit before issue.
    try:
        from app.services.stock_service import _get_or_create_balance
        from app.models.issue import MaterialIssueItem
        from app.models.warehouse import Warehouse as _WHModel
        from app.models.stock import StockBalance
        from decimal import Decimal

        src_wh_id = payload.warehouseId
        is_multi_level = (payload.dispatch_mode or "direct").lower() == "multi-level"

        # Identify Central Warehouse by parent_id IS NULL (top-level warehouse)
        # Using parent_id=NULL is robust — not affected by name/code/id changes.
        is_central_warehouse = False
        if src_wh_id:
            cen_res = await db.execute(
                select(_WHModel).where(_WHModel.id == src_wh_id)
            )
            src_wh = cen_res.scalar_one_or_none()
            if src_wh and src_wh.parent_id is None:
                is_central_warehouse = True

        # Run the reserved→transit conversion for:
        #   • Multi-level dispatches from any warehouse (when not THIRD_PARTY)
        if src_wh_id and is_multi_level and (payload.dispatch_type or "THIRD_PARTY") != "THIRD_PARTY":
            for mat in payload.materials:
                batch_id_r = None
                bin_id_r = None
                if payload.material_issue_id:
                    mi_item_res = await db.execute(
                        select(MaterialIssueItem).where(
                            MaterialIssueItem.issue_id == payload.material_issue_id,
                            MaterialIssueItem.item_id == mat.materialId
                        ).limit(1)
                    )
                    mi_item_r = mi_item_res.scalar_one_or_none()
                    if mi_item_r:
                        batch_id_r = mi_item_r.batch_id
                        bin_id_r = mi_item_r.bin_id

                qty_r = Decimal(str(mat.qty))
                src_bal = await _get_or_create_balance(
                    db,
                    item_id=mat.materialId,
                    warehouse_id=src_wh_id,
                    bin_id=bin_id_r,
                    batch_id=batch_id_r,
                    lock=True,
                )
                # Convert existing reserved_qty → transit_qty only.
                # (reserved was set by issue_material; now it's actively in-transit)
                # NEVER add to transit if there is no reservation — that caused
                # premature transit display before the Issue button was clicked.
                convert_qty = min(src_bal.reserved_qty or Decimal("0"), qty_r)
                if convert_qty > Decimal("0"):
                    src_bal.reserved_qty = (src_bal.reserved_qty or Decimal("0")) - convert_qty
                    src_bal.transit_qty = (src_bal.transit_qty or Decimal("0")) + convert_qty
                    # Recompute available: total - reserved - transit
                    src_bal.available_qty = max(
                        Decimal("0"),
                        (src_bal.total_qty or Decimal("0"))
                        - (src_bal.reserved_qty or Decimal("0"))
                        - (src_bal.transit_qty or Decimal("0"))
                    )
                
                remaining_convert = qty_r - convert_qty
                if remaining_convert > Decimal("0"):
                    # Fallback: find other balances with reserved_qty > 0 and convert them
                    stmt_other = select(StockBalance).where(
                        StockBalance.item_id == mat.materialId,
                        StockBalance.warehouse_id == src_wh_id,
                        StockBalance.reserved_qty > 0,
                        StockBalance.id != src_bal.id
                    ).with_for_update()
                    res_other = await db.execute(stmt_other)
                    other_bals = res_other.scalars().all()
                    for ob in other_bals:
                        if remaining_convert <= Decimal("0"):
                            break
                        take = min(ob.reserved_qty or Decimal("0"), remaining_convert)
                        if take > Decimal("0"):
                            ob.reserved_qty = (ob.reserved_qty or Decimal("0")) - take
                            ob.transit_qty = (ob.transit_qty or Decimal("0")) + take
                            ob.available_qty = max(
                                Decimal("0"),
                                (ob.total_qty or Decimal("0"))
                                - (ob.reserved_qty or Decimal("0"))
                                - (ob.transit_qty or Decimal("0"))
                            )
                            remaining_convert -= take
            await db.flush()
    except Exception as mdo_transit_err:
        import logging
        logging.getLogger(__name__).warning(
            "MDO source reserved→transit conversion failed (non-blocking): %s", mdo_transit_err
        )


    db.add(ActivityLog(
        user_id=current_user.id,
        module="logistics",
        action="create_mdo",
        entity_type="mdo",
        entity_id=new_mdo.id,
        description=f"Created Main Dispatch Order {mdo_num} with dispatch mode {dispatch_mode}. Source stock reserved at warehouse {payload.warehouseId}."
    ))

    db.add(Notification(
        user_id=current_user.id,
        title="Draft MDO Initialized",
        message=f"Main Dispatch Order {mdo_num} has been successfully created.",
        type="info",
        module="logistics",
        reference_type="MDO",
        reference_id=new_mdo.id
    ))

    await db.commit()
    return {"message": "MDO created successfully", "mdo_id": new_mdo.id, "mdo_number": mdo_num}


@router.post("/sdo/{sdo_id}/handover")
async def sdo_handover(
    sdo_id: int,
    payload: SdoHandoverSchema,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    res = await db.execute(select(LogisticsSubDispatchOrder).where(LogisticsSubDispatchOrder.id == sdo_id))
    sdo = res.scalar_one_or_none()
    if not sdo:
        raise HTTPException(404, "Sub-dispatch order leg not found")

    res_mdo = await db.execute(select(LogisticsMainDispatchOrder).where(LogisticsMainDispatchOrder.id == sdo.mdo_id))
    mdo = res_mdo.scalar_one_or_none()
    if not mdo:
        raise HTTPException(404, "Parent MDO not found")

    # Prevent handover on final terminal leg
    try:
        from app.api.v1.dispatch import get_destination_position_id
        dest_pos_id = await get_destination_position_id(db, mdo.destination_warehouse_id, mdo.destination_user_id)
        project_id = await resolve_mdo_project_id(db, mdo.indent_id, mdo.material_issue_id)
        starting_pos_id = await resolve_indent_creator_position(db, mdo.indent_id, mdo.material_issue_id)

        chain_data = []
        if mdo.dispatch_mode == "multi-level" and project_id and starting_pos_id:
            chain_data = await build_logistics_custody_chain(db, project_id, starting_pos_id, dest_pos_id)
        chain = [entry["position"] for entry in chain_data if entry.get("can_approve", False) or entry.get("is_destination", False)]

        if chain and sdo.sequence_number > len(chain):
            raise HTTPException(400, "Handover is not allowed on the final delivery leg.")
    except HTTPException:
        raise
    except Exception:
        pass

    is_authorized = False
    from app.utils.dependencies import get_user_role_codes
    user_role_codes = await get_user_role_codes(db, current_user.id)
    if any(code in ("admin", "super_admin", "logistics_manager") for code in user_role_codes):
        is_authorized = True
    else:
        from app.models.settings_master import Employee, Position as HndPosition
        emp_res = await db.execute(select(Employee).where(Employee.id == current_user.employee_id))
        emp = emp_res.scalar_one_or_none()
        if emp:
            # Collect ALL positions this employee holds (not just the active one)
            all_pos_res = await db.execute(
                select(HndPosition.id).where(HndPosition.employee_id == emp.id)
            )
            all_emp_pos_ids = set(all_pos_res.scalars().all())
            if emp.position_id:
                all_emp_pos_ids.add(emp.position_id)
            if sdo.custodian_position_id in all_emp_pos_ids:
                is_authorized = True

    if not is_authorized:
        raise HTTPException(403, "You are not authorized to handover this dispatch leg")

    # Restrict THIRD_PARTY for intermediate positions in multi-level mode
    if payload.handover_type == "THIRD_PARTY" and mdo.dispatch_mode == "multi-level":
        from app.api.v1.dispatch import get_destination_position_id
        dest_pos_id = await get_destination_position_id(db, mdo.destination_warehouse_id, mdo.destination_user_id)
        project_id = await resolve_mdo_project_id(db, mdo.indent_id, mdo.material_issue_id)
        starting_pos_id = await resolve_indent_creator_position(db, mdo.indent_id, mdo.material_issue_id)

        chain_data = []
        if project_id and starting_pos_id:
            chain_data = await build_logistics_custody_chain(db, project_id, starting_pos_id, dest_pos_id)
        chain = [entry["position"] for entry in chain_data if entry.get("can_approve", False) or entry.get("is_destination", False)]
        
        if sdo.sequence_number < len(chain):
            raise HTTPException(400, "THIRD_PARTY handover is not allowed for intermediate positions. Use OWN_VEHICLE, COURIER, or IN_PERSON.")

    sdo.status = "HANDED_OVER"
    sdo.handover_type = payload.handover_type
    sdo.handed_over_by_id = current_user.id
    sdo.handover_time = datetime.now(timezone.utc)
    sdo.carrier_details = {
        "vehicle_no": payload.vehicle_no,
        "driver_name": payload.driver_name,
        "driver_phone": payload.driver_phone,
        "courier_name": payload.courier_name,
        "awb_no": payload.awb_no,
        "remarks": payload.remarks,
        "otp": payload.otp
    }
    if payload.handover_photos:
        sdo.handover_photos = payload.handover_photos
    if payload.handover_signature:
        sdo.handover_signature = payload.handover_signature
    db.add(sdo)

    mdo.status = "IN_TRANSIT"
    db.add(mdo)

    # For multi-level intermediate handovers, move stock from available_qty to transit_qty
    # at the sender's warehouse (custodian of the previous leg).
    # This does NOT reduce total_qty — it only signals the stock is "in-transit" out of that warehouse.
    # The actual total_qty deduction at that warehouse happens at SDO receive time.
    if mdo.dispatch_mode == "multi-level":
        try:
            from app.api.v1.dispatch import get_warehouse_for_position
            from app.services.stock_service import _get_or_create_balance
            from decimal import Decimal

            sender_wh_id = None
            if sdo.sequence_number > 1:
                prev_sdo_res = await db.execute(
                    select(LogisticsSubDispatchOrder).where(
                        LogisticsSubDispatchOrder.mdo_id == mdo.id,
                        LogisticsSubDispatchOrder.sequence_number == sdo.sequence_number - 1
                    ).order_by(LogisticsSubDispatchOrder.id.desc()).limit(1)
                )
                prev_sdo = prev_sdo_res.scalar_one_or_none()
                if prev_sdo and prev_sdo.custodian_position_id:
                    sender_wh_id = await get_warehouse_for_position(db, prev_sdo.custodian_position_id)
                if not sender_wh_id:
                    sender_wh_id = mdo.warehouse_id

            if sender_wh_id:
                res_mats = await db.execute(
                    select(LogisticsDispatchMaterial).where(LogisticsDispatchMaterial.mdo_id == mdo.id)
                )
                mats = res_mats.scalars().all()

                for mat in mats:
                    batch_id = None
                    bin_id = None
                    if mdo.material_issue_id:
                        from app.models.issue import MaterialIssueItem
                        mi_item_res = await db.execute(
                            select(MaterialIssueItem).where(
                                MaterialIssueItem.issue_id == mdo.material_issue_id,
                                MaterialIssueItem.item_id == mat.material_id
                            ).limit(1)
                        )
                        mi_item = mi_item_res.scalar_one_or_none()
                        if mi_item:
                            batch_id = mi_item.batch_id
                            bin_id = mi_item.bin_id

                    qty = Decimal(str(mat.quantity))

                    # INVENTORY RULE: On handover of leg N (N > 1), shift available_qty → transit_qty at sender warehouse
                    sender_balance = await _get_or_create_balance(
                        db,
                        item_id=mat.material_id,
                        warehouse_id=sender_wh_id,
                        bin_id=bin_id,
                        batch_id=batch_id,
                        lock=True,
                    )
                    # Reduce available_qty (clamp at zero)
                    sender_balance.available_qty = max(
                        Decimal("0"),
                        (sender_balance.available_qty or Decimal("0")) - qty
                    )
                    # Increment transit_qty
                    sender_balance.transit_qty = (sender_balance.transit_qty or Decimal("0")) + qty

                await db.flush()

                # Notify next-leg custodian's warehouse users about incoming shipment
                try:
                    from app.api.v1.dispatch import get_destination_position_id as _get_dest_pos
                    dest_pos_id_for_notify = await get_destination_position_id(db, mdo.destination_warehouse_id, mdo.destination_user_id)
                    project_id_for_notify = await resolve_mdo_project_id(db, mdo.indent_id, mdo.material_issue_id)
                    starting_pos_id_for_notify = await resolve_indent_creator_position(db, mdo.indent_id, mdo.material_issue_id)
                    chain_notify_data = []
                    if project_id_for_notify and starting_pos_id_for_notify:
                        chain_notify_data = await build_logistics_custody_chain(db, project_id_for_notify, starting_pos_id_for_notify, dest_pos_id_for_notify)
                    chain_notify = [entry["position"] for entry in chain_notify_data if entry.get("can_approve", False) or entry.get("is_destination", False)]
                    if sdo.sequence_number < len(chain_notify):
                        next_pos = chain_notify[sdo.sequence_number]
                        from app.models.settings_master import Employee as _Emp
                        from app.models.user import User as _User
                        next_user_res = await db.execute(
                            select(_User).join(_Emp, _Emp.id == _User.employee_id)
                            .where(_Emp.position_id == next_pos.id)
                        )
                        for next_user in next_user_res.scalars().all():
                            db.add(Notification(
                                user_id=next_user.id,
                                title="Dispatch Shipment En Route",
                                message=f"Dispatch {mdo.mdo_number} (SDO leg {sdo.sequence_number}) has been handed over by {current_user.username} and is now in transit to your custody. Please be prepared to receive.",
                                type="info",
                                module="logistics",
                                reference_type="MDO",
                                reference_id=mdo.id
                            ))
                except Exception:
                    pass
        except Exception as handover_stock_err:
            import logging
            logging.getLogger(__name__).exception("Failed to perform intermediate warehouse handover stock transfer")

    # Dynamic creation of the next SDO leg
    from app.api.v1.dispatch import get_destination_position_id
    dest_pos_id = await get_destination_position_id(db, mdo.destination_warehouse_id, mdo.destination_user_id)
    project_id = await resolve_mdo_project_id(db, mdo.indent_id, mdo.material_issue_id)
    starting_pos_id = await resolve_indent_creator_position(db, mdo.indent_id, mdo.material_issue_id)

    chain_data = []
    if mdo.dispatch_mode == "multi-level" and project_id and starting_pos_id:
        chain_data = await build_logistics_custody_chain(db, project_id, starting_pos_id, dest_pos_id)
    chain = [entry["position"] for entry in chain_data if entry.get("can_approve", False) or entry.get("is_destination", False)]

    if sdo.sequence_number < len(chain):
        next_pos = chain[sdo.sequence_number]
        # Avoid creating duplicate next leg SDOs
        existing_next_res = await db.execute(
            select(LogisticsSubDispatchOrder).where(
                LogisticsSubDispatchOrder.mdo_id == mdo.id,
                LogisticsSubDispatchOrder.sequence_number == sdo.sequence_number + 1
            )
        )
        if not existing_next_res.scalar_one_or_none():
            sdo_num = await generate_logistics_sequence_number(
                db,
                prefix="SDO",
                document_type="sub_dispatch_order",
            )
            next_sdo = LogisticsSubDispatchOrder(
                sdo_number=sdo_num,
                mdo_id=mdo.id,
                route_id=None,
                route_name=f"Custody Leg {sdo.sequence_number + 1}",
                vehicle_type_required="Truck",
                estimated_distance_km=100.0,
                required_pickup_datetime=datetime.now(timezone.utc),
                required_delivery_datetime=datetime.now(timezone.utc) + timedelta(days=2),
                loading_time_minutes=30,
                unloading_time_minutes=30,
                requires_loading_helper=False,
                status="PENDING",
                custodian_position_id=next_pos.id,
                sequence_number=sdo.sequence_number + 1,
                estimated_weight_kg=sdo.estimated_weight_kg,
                estimated_volume_cft=sdo.estimated_volume_cft
            )
            db.add(next_sdo)

    db.add(ActivityLog(
        user_id=current_user.id,
        module="logistics",
        action="sdo_handover",
        entity_type="sdo",
        entity_id=sdo.id,
        description=f"SDO leg {sdo.sdo_number} handed over via {payload.handover_type}."
    ))

    await db.commit()
    return {"success": True, "message": "Custody leg handed over successfully."}


@router.post("/sdo/{sdo_id}/receive")
async def sdo_receive(
    sdo_id: int,
    payload: SdoReceiveSchema,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    res = await db.execute(
        select(LogisticsSubDispatchOrder)
        .options(selectinload(LogisticsSubDispatchOrder.mdo))
        .where(LogisticsSubDispatchOrder.id == sdo_id)
    )
    sdo = res.scalar_one_or_none()
    if not sdo:
        raise HTTPException(404, "Sub-dispatch order leg not found")

    mdo = sdo.mdo
    if not mdo:
        raise HTTPException(404, "Parent MDO not found")

    # Prevent receive on final terminal leg
    try:
        from app.api.v1.dispatch import get_destination_position_id
        dest_pos_id = await get_destination_position_id(db, mdo.destination_warehouse_id, mdo.destination_user_id)
        project_id = await resolve_mdo_project_id(db, mdo.indent_id, mdo.material_issue_id)
        starting_pos_id = await resolve_indent_creator_position(db, mdo.indent_id, mdo.material_issue_id)

        chain_data = []
        if mdo.dispatch_mode == "multi-level" and project_id and starting_pos_id:
            chain_data = await build_logistics_custody_chain(db, project_id, starting_pos_id, dest_pos_id)
        chain = [entry["position"] for entry in chain_data if entry.get("can_approve", False) or entry.get("is_destination", False)]

        if chain and sdo.sequence_number >= len(chain):
            raise HTTPException(400, "Final delivery acknowledgement must be processed via the Acknowledge Delivery tab.")
    except HTTPException:
        raise
    except Exception:
        pass

    # Auth check: user must occupy the custodian position for this SDO.
    # Check ALL positions this employee holds, not just the currently-active one, so
    # a user who switched positions still has the right to receive a leg assigned to
    # any of their roles.
    from app.models.settings_master import Employee as RecvEmployee, Position as RecvPosition
    recv_emp_res = await db.execute(
        select(RecvEmployee).where(RecvEmployee.id == current_user.employee_id)
    )
    recv_emp = recv_emp_res.scalar_one_or_none()
    from app.utils.dependencies import get_user_role_codes
    user_role_codes = await get_user_role_codes(db, current_user.id)

    user_has_custodian_position = False
    if recv_emp:
        # All positions linked to this employee via Position.employee_id
        all_pos_res = await db.execute(
            select(RecvPosition.id).where(RecvPosition.employee_id == recv_emp.id)
        )
        all_pos_ids = set(all_pos_res.scalars().all())
        # Also include the currently-active position
        if recv_emp.position_id:
            all_pos_ids.add(recv_emp.position_id)
        user_has_custodian_position = sdo.custodian_position_id in all_pos_ids

    if not user_has_custodian_position:
        if not any(code in ("admin", "super_admin", "logistics_manager") for code in user_role_codes):
            raise HTTPException(403, "You do not occupy the required position to receive this dispatch leg")

    sdo.status = "ACKNOWLEDGED"
    sdo.received_by_id = current_user.id
    sdo.received_at = datetime.now(timezone.utc)
    sdo.seal_intact = payload.seal_intact
    sdo.packaging_condition = payload.packaging_condition
    sdo.discrepancy_reported = payload.discrepancy_reported
    sdo.receiving_remarks = payload.receiving_remarks
    if payload.receipt_photos:
        sdo.receipt_photos = payload.receipt_photos
    if payload.receipt_signature:
        sdo.receipt_signature = payload.receipt_signature
    db.add(sdo)

    # Flush SDO status change early to catch ENUM→VARCHAR issues before
    # proceeding with the rest of the logic.  If the column is still an
    # ENUM that doesn't include 'ACKNOWLEDGED', fix it on-the-fly and retry.
    try:
        await db.flush()
    except Exception as flush_err:
        if "Data truncated" in str(flush_err) or "1265" in str(flush_err):
            # Column is still ENUM — fix it now via raw DDL and retry
            try:
                raw_conn = await db.connection()
                await raw_conn.execute(text(
                    "ALTER TABLE logistics_sub_dispatch_orders "
                    "MODIFY COLUMN status VARCHAR(50) NOT NULL DEFAULT 'PENDING'"
                ))
                await db.flush()
            except Exception:
                # Last resort: bypass ORM and use raw UPDATE
                await db.rollback()
                raw_conn = await db.connection()
                await raw_conn.execute(text(
                    "UPDATE logistics_sub_dispatch_orders "
                    "SET status = 'ACKNOWLEDGED', "
                    "    received_by_id = :uid, "
                    "    received_at = NOW(), "
                    "    seal_intact = :seal, "
                    "    packaging_condition = :pkg, "
                    "    discrepancy_reported = :disc, "
                    "    receiving_remarks = :remarks "
                    "WHERE id = :sdo_id"
                ), {
                    "uid": current_user.id,
                    "seal": payload.seal_intact,
                    "pkg": payload.packaging_condition,
                    "disc": payload.discrepancy_reported,
                    "remarks": payload.receiving_remarks,
                    "sdo_id": sdo_id,
                })
                await raw_conn.commit()
        else:
            raise

    # Resolve active custodian's role code to set dynamic MDO status
    from app.models.settings_master import Position
    from app.models.user import Role
    role_code = "CUSTODIAN"
    pos_q = await db.execute(select(Position).where(Position.id == sdo.custodian_position_id))
    pos = pos_q.scalar_one_or_none()
    if pos and pos.role_id:
        role_q = await db.execute(select(Role).where(Role.id == pos.role_id))
        role_obj = role_q.scalar_one_or_none()
        if role_obj:
            role_code = role_obj.code

    # Set MDO status to reflect current custodian role.
    # If the column is still an ENUM that can't hold AT_* values,
    # fall back to IN_TRANSIT which is always valid.
    dynamic_status = f"AT_{role_code.upper()}"
    try:
        mdo.status = dynamic_status
        db.add(mdo)
        await db.flush()
    except Exception:
        # ENUM doesn't support AT_* — fall back to a standard status
        await db.rollback()
        # Re-fetch mdo since rollback detached it
        mdo_res = await db.execute(
            select(LogisticsMainDispatchOrder).where(LogisticsMainDispatchOrder.id == sdo.mdo_id)
        )
        mdo = mdo_res.scalar_one_or_none()
        mdo.status = "IN_TRANSIT"
        db.add(mdo)
        try:
            await db.flush()
        except Exception:
            # Last resort: raw SQL
            raw_conn = await db.connection()
            await raw_conn.execute(text(
                "UPDATE logistics_main_dispatch_orders SET status = 'IN_TRANSIT' WHERE id = :mdo_id"
            ), {"mdo_id": mdo.id})
            await raw_conn.commit()

    db.add(ActivityLog(
        user_id=current_user.id,
        module="logistics",
        action="sdo_receive",
        entity_type="sdo",
        entity_id=sdo.id,
        description=f"Custody of SDO leg {sdo.sdo_number} acknowledged by {current_user.username} (Status: {mdo.status})."
    ))

    # Notify MDO creator/dispatcher of each custody acknowledgement for real-time visibility
    if mdo.created_by:
        db.add(Notification(
            user_id=mdo.created_by,
            title="Dispatch Custody Leg Acknowledged",
            message=f"Dispatch {mdo.mdo_number}: SDO leg {sdo.sdo_number} (sequence {sdo.sequence_number}) has been acknowledged by {current_user.username}. Inventory updated accordingly.",
            type="info",
            module="logistics",
            reference_type="MDO",
            reference_id=mdo.id
        ))

    # Resolve custody chain to check if this is the final leg.
    # Wrap in try/except so chain resolution failures don't crash the acknowledgement.
    is_last_leg = False
    try:
        from app.api.v1.dispatch import get_destination_position_id
        dest_pos_id = await get_destination_position_id(db, mdo.destination_warehouse_id, mdo.destination_user_id)
        project_id = await resolve_mdo_project_id(db, mdo.indent_id, mdo.material_issue_id)
        starting_pos_id = await resolve_indent_creator_position(db, mdo.indent_id, mdo.material_issue_id)

        chain_data = []
        if mdo.dispatch_mode == "multi-level" and project_id and starting_pos_id:
            chain_data = await build_logistics_custody_chain(db, project_id, starting_pos_id, dest_pos_id)
        chain = [entry["position"] for entry in chain_data if entry.get("can_approve", False) or entry.get("is_destination", False)]

        if not chain or sdo.sequence_number >= len(chain):
            is_last_leg = True
    except Exception as chain_err:
        import traceback
        traceback.print_exc()
        print(f"[WARNING] Custody chain resolution failed: {chain_err}")
        # Default: if only one SDO exists, treat as last leg
        all_sdos_res = await db.execute(
            select(LogisticsSubDispatchOrder.id).where(LogisticsSubDispatchOrder.mdo_id == mdo.id)
        )
        all_sdo_ids = all_sdos_res.scalars().all()
        if len(all_sdo_ids) <= 1:
            is_last_leg = True

    # Stock transit movement for intermediate legs of multi-level dispatches.
    # INVENTORY RULE at SDO RECEIVE (intermediate leg):
    #   1. Decrement transit_qty at PREVIOUS warehouse (the one that handed over)
    #   2. Decrement total_qty at PREVIOUS warehouse (goods physically left that warehouse)
    #   3. Increment available_qty at CURRENT warehouse (goods arrived and receivable)
    #   4. Increment total_qty at CURRENT warehouse (goods physically present now)
    # Notify current warehouse users that stock has arrived and DM dispatch can proceed.
    if mdo.dispatch_mode == "multi-level" and not is_last_leg:
        try:
            from app.api.v1.dispatch import get_warehouse_for_position
            from app.services.stock_service import _get_or_create_balance, post_stock_ledger
            from decimal import Decimal

            # Resolve previous warehouse (the one that handed off to this SDO)
            # PRIMARY: Look up the actual previous SDO in this MDO by sequence number
            # and use its custodian_position_id to find the exact warehouse that handed over.
            prev_wh_id = mdo.warehouse_id  # fallback to source
            if sdo.sequence_number > 1:
                prev_sdo_res = await db.execute(
                    select(LogisticsSubDispatchOrder).where(
                        LogisticsSubDispatchOrder.mdo_id == mdo.id,
                        LogisticsSubDispatchOrder.sequence_number == sdo.sequence_number - 1
                    ).order_by(LogisticsSubDispatchOrder.id.desc()).limit(1)
                )
                prev_sdo = prev_sdo_res.scalar_one_or_none()
                if prev_sdo and prev_sdo.custodian_position_id:
                    resolved_prev_wh = await get_warehouse_for_position(db, prev_sdo.custodian_position_id)
                    if resolved_prev_wh:
                        prev_wh_id = resolved_prev_wh
                    elif "chain" in locals() and chain and len(chain) >= sdo.sequence_number - 1:
                        # Secondary fallback: use chain index
                        prev_pos = chain[sdo.sequence_number - 2]
                        prev_wh_id = await get_warehouse_for_position(db, prev_pos.id) or mdo.warehouse_id
                elif "chain" in locals() and chain and len(chain) >= sdo.sequence_number - 1:
                    prev_pos = chain[sdo.sequence_number - 2]
                    prev_wh_id = await get_warehouse_for_position(db, prev_pos.id) or mdo.warehouse_id

            # Resolve current warehouse (the receiver / this SDO's custodian)
            curr_wh_id = await get_warehouse_for_position(db, sdo.custodian_position_id) or mdo.destination_warehouse_id

            if prev_wh_id and curr_wh_id:
                res_mats = await db.execute(
                    select(LogisticsDispatchMaterial).where(LogisticsDispatchMaterial.mdo_id == mdo.id)
                )
                mats = res_mats.scalars().all()

                for mat in mats:
                    # Check for duplicate ledger entry to prevent double-posting
                    from app.models.stock import StockLedger
                    dup_check = await db.execute(
                        select(StockLedger).where(
                            StockLedger.reference_type == "sub_dispatch_order",
                            StockLedger.reference_id == sdo.id,
                            StockLedger.item_id == mat.material_id,
                        ).limit(1)
                    )
                    if dup_check.scalar_one_or_none():
                        continue

                    batch_id = None
                    bin_id = None
                    if mdo.material_issue_id:
                        from app.models.issue import MaterialIssueItem
                        mi_item_res = await db.execute(
                            select(MaterialIssueItem).where(
                                MaterialIssueItem.issue_id == mdo.material_issue_id,
                                MaterialIssueItem.item_id == mat.material_id
                            ).limit(1)
                        )
                        mi_item = mi_item_res.scalar_one_or_none()
                        if mi_item:
                            batch_id = mi_item.batch_id
                            bin_id = mi_item.bin_id

                    qty = Decimal(str(mat.quantity))

                    # Step 1 & 2: At PREVIOUS warehouse — clear transit_qty
                    prev_balance = await _get_or_create_balance(
                        db,
                        item_id=mat.material_id,
                        warehouse_id=prev_wh_id,
                        bin_id=bin_id,
                        batch_id=batch_id,
                        lock=True,
                    )
                    prev_balance.transit_qty = max(Decimal("0"), (prev_balance.transit_qty or Decimal("0")) - qty)

                    if prev_wh_id != curr_wh_id:
                        # Post stock ledger entry to deduct total quantity and record the transfer out
                        await post_stock_ledger(
                            db,
                            item_id=mat.material_id,
                            warehouse_id=prev_wh_id,
                            transaction_type="transfer_out",
                            qty_out=qty,
                            batch_id=batch_id,
                            bin_id=bin_id,
                            reference_type="sub_dispatch_order",
                            reference_id=sdo.id,
                            uom_id=1,
                            created_by=current_user.id,
                        )

                        # Steps 3 & 4: At CURRENT warehouse — add to available_qty and total_qty (goods physically arrived)
                        await post_stock_ledger(
                            db,
                            item_id=mat.material_id,
                            warehouse_id=curr_wh_id,
                            transaction_type="transfer_in",
                            qty_in=qty,
                            batch_id=batch_id,
                            bin_id=bin_id,
                            reference_type="sub_dispatch_order",
                            reference_id=sdo.id,
                            uom_id=1,
                            created_by=current_user.id,
                        )
                    else:
                        # If same warehouse, just move transit_qty back to available_qty directly on the balance.
                        prev_balance.available_qty = max(
                            Decimal("0"),
                            (prev_balance.total_qty or Decimal("0"))
                            - (prev_balance.reserved_qty or Decimal("0"))
                            - (prev_balance.transit_qty or Decimal("0"))
                        )

                await db.flush()

                # Dynamic creation of the next SDO leg (if it doesn't already exist).
                # Added as a safety fallback in case handover of the current leg was bypassed.
                try:
                    from app.api.v1.dispatch import get_destination_position_id
                    dest_pos_id = await get_destination_position_id(db, mdo.destination_warehouse_id, mdo.destination_user_id)
                    project_id = await resolve_mdo_project_id(db, mdo.indent_id, mdo.material_issue_id)
                    starting_pos_id = await resolve_indent_creator_position(db, mdo.indent_id, mdo.material_issue_id)

                    chain_data = []
                    if project_id and starting_pos_id:
                        chain_data = await build_logistics_custody_chain(db, project_id, starting_pos_id, dest_pos_id)
                    chain = [entry["position"] for entry in chain_data if entry.get("can_approve", False) or entry.get("is_destination", False)]

                    if sdo.sequence_number < len(chain):
                        next_pos = chain[sdo.sequence_number]
                        # Avoid creating duplicate next leg SDOs
                        existing_next_res = await db.execute(
                            select(LogisticsSubDispatchOrder).where(
                                LogisticsSubDispatchOrder.mdo_id == mdo.id,
                                LogisticsSubDispatchOrder.sequence_number == sdo.sequence_number + 1
                            )
                        )
                        if not existing_next_res.scalar_one_or_none():
                            sdo_num = await generate_logistics_sequence_number(
                                db,
                                prefix="SDO",
                                document_type="sub_dispatch_order",
                            )
                            next_sdo = LogisticsSubDispatchOrder(
                                sdo_number=sdo_num,
                                mdo_id=mdo.id,
                                route_id=None,
                                route_name=f"Custody Leg {sdo.sequence_number + 1}",
                                vehicle_type_required="Truck",
                                estimated_distance_km=100.0,
                                required_pickup_datetime=datetime.now(timezone.utc),
                                required_delivery_datetime=datetime.now(timezone.utc) + timedelta(days=2),
                                loading_time_minutes=30,
                                unloading_time_minutes=30,
                                requires_loading_helper=False,
                                status="PENDING",
                                custodian_position_id=next_pos.id,
                                sequence_number=sdo.sequence_number + 1,
                                estimated_weight_kg=sdo.estimated_weight_kg,
                                estimated_volume_cft=sdo.estimated_volume_cft
                            )
                            db.add(next_sdo)
                            await db.flush()
                except Exception as next_leg_err:
                    import logging
                    logging.getLogger(__name__).warning("Fallback dynamic SDO generation failed: %s", next_leg_err)

                # Notify current warehouse users that stock has arrived (DM dispatch can now proceed)
                try:
                    from app.models.user import User as _NotifUser
                    from app.models.user import UserWarehouse as _UW
                    curr_wh_user_res = await db.execute(
                        select(_NotifUser).join(_UW, _UW.user_id == _NotifUser.id)
                        .where(_UW.warehouse_id == curr_wh_id)
                    )
                    for wh_user in curr_wh_user_res.scalars().all():
                        db.add(Notification(
                            user_id=wh_user.id,
                            title="Stock Received at Your Warehouse",
                            message=f"Dispatch {mdo.mdo_number}: Stock has arrived at your warehouse (SDO leg {sdo.sequence_number} received). Inventory updated. Proceed with DM dispatch when ready.",
                            type="success",
                            module="logistics",
                            reference_type="MDO",
                            reference_id=mdo.id
                        ))
                except Exception:
                    pass
        except Exception as stock_move_err:
            import logging
            logging.getLogger(__name__).exception("Failed to perform intermediate warehouse transit stock transfer")

    if is_last_leg:
        mdo.status = "COMPLETED"
        db.add(mdo)
        await db.flush()

        from app.models.dispatch import DispatchOrder, DispatchOrderItem
        disp_check = await db.execute(select(DispatchOrder).where(DispatchOrder.dispatch_number == mdo.mdo_number))
        disp = disp_check.scalar_one_or_none()

        if not disp:
            # Map MDO dispatch_type (may be lowercase like "own vehicle") to DispatchOrder Enum values
            dt_map = {
                "own vehicle": "OWN_VEHICLE",
                "OWN_VEHICLE": "OWN_VEHICLE",
                "COURIER": "COURIER",
                "courier": "COURIER",
                "IN_PERSON": "IN_PERSON",
                "in person": "IN_PERSON",
                "THIRD_PARTY": "THIRD_PARTY",
                "third party": "THIRD_PARTY",
            }
            mapped_dispatch_type = dt_map.get(mdo.dispatch_type, "THIRD_PARTY") if mdo.dispatch_type else "THIRD_PARTY"

            disp = DispatchOrder(
                dispatch_number=mdo.mdo_number,
                warehouse_id=mdo.warehouse_id,
                destination_warehouse_id=mdo.destination_warehouse_id,
                destination_user_id=mdo.destination_user_id,
                destination_type="WAREHOUSE" if mdo.destination_warehouse_id else "USER",
                dispatch_type=mapped_dispatch_type,
                status="delivered",
                remarks=mdo.special_instructions,
                material_issue_id=mdo.material_issue_id,
                dispatch_date=mdo.order_date,
                expected_delivery_date=mdo.required_delivery_date,
                delivery_acknowledged=True,
                delivery_acknowledged_at=datetime.now(timezone.utc),
                delivery_acknowledged_by_name=current_user.username,
                delivery_remarks=payload.receiving_remarks,
                goods_condition_on_delivery="DAMAGED" if payload.discrepancy_reported else "GOOD"
            )
            db.add(disp)
            await db.flush()

            res_mats = await db.execute(select(LogisticsDispatchMaterial).where(LogisticsDispatchMaterial.mdo_id == mdo.id))
            mats = res_mats.scalars().all()
            for mat in mats:
                item = DispatchOrderItem(
                    dispatch_order_id=disp.id,
                    material_id=mat.material_id,
                    indent_id=mdo.indent_id,
                    material_issue_id=mdo.material_issue_id,
                    requested_quantity=mat.quantity,
                    approved_quantity=mat.quantity,
                    dispatched_quantity=mat.quantity,
                    uom=mat.unit_of_measure,
                    request_date=mdo.order_date
                )
                db.add(item)
            await db.flush()

        # Process stock deduction; wrap in try/except so a stock failure
        # does not crash the acknowledgement itself.
        # NOTE: For multi-level dispatches, the last-leg `process_dispatch_stock_deduction`
        # deducts from mdo.warehouse_id (origin). But for multi-level, stock was already
        # tracked through the SDO chain. Here we only need to add stock to the destination.
        # Check if this is multi-level and skip the origin deduction in that case.
        try:
            dispatch_mode_val = getattr(mdo, "dispatch_mode", "direct") or "direct"
            if dispatch_mode_val.lower() == "multi-level":
                # For multi-level: stock was already removed from origin at SDO1 handover.
                # We need only to credit destination warehouse with the received stock.
                from app.services.stock_service import _get_or_create_balance, post_stock_ledger
                from decimal import Decimal

                dest_wh_id = mdo.destination_warehouse_id
                if dest_wh_id:
                    # Resolve last intermediate warehouse to decrement its transit_qty
                    from app.api.v1.dispatch import get_last_intermediate_warehouse, get_warehouse_for_position
                    last_int_wh_id = await get_last_intermediate_warehouse(db, disp)

                    res_mats_final = await db.execute(select(LogisticsDispatchMaterial).where(LogisticsDispatchMaterial.mdo_id == mdo.id))
                    mats_final = res_mats_final.scalars().all()

                    for mat_f in mats_final:
                        # Check for duplicate ledger entry to prevent double-posting
                        from app.models.stock import StockLedger
                        dup_check = await db.execute(
                            select(StockLedger).where(
                                StockLedger.reference_type == "sdo_final_delivery",
                                StockLedger.reference_id == sdo.id,
                                StockLedger.item_id == mat_f.material_id,
                            ).limit(1)
                        )
                        if dup_check.scalar_one_or_none():
                            continue

                        batch_id_f = None
                        bin_id_f = None
                        if mdo.material_issue_id:
                            from app.models.issue import MaterialIssueItem
                            mi_f_res = await db.execute(
                                select(MaterialIssueItem).where(
                                    MaterialIssueItem.issue_id == mdo.material_issue_id,
                                    MaterialIssueItem.item_id == mat_f.material_id
                                ).limit(1)
                            )
                            mi_f = mi_f_res.scalar_one_or_none()
                            if mi_f:
                                batch_id_f = mi_f.batch_id
                                bin_id_f = mi_f.bin_id

                        qty_f = Decimal(str(mat_f.quantity))

                        # Decrement transit_qty from last intermediate warehouse
                        if last_int_wh_id and last_int_wh_id != dest_wh_id:
                            last_int_bal = await _get_or_create_balance(
                                db,
                                item_id=mat_f.material_id,
                                warehouse_id=last_int_wh_id,
                                bin_id=bin_id_f,
                                batch_id=batch_id_f,
                                lock=True,
                            )
                            last_int_bal.transit_qty = max(Decimal("0"), (last_int_bal.transit_qty or Decimal("0")) - qty_f)
                            
                            # Post stock ledger entry to deduct total quantity and record the transfer out
                            await post_stock_ledger(
                                db,
                                item_id=mat_f.material_id,
                                warehouse_id=last_int_wh_id,
                                transaction_type="transfer_out",
                                qty_out=qty_f,
                                batch_id=batch_id_f,
                                bin_id=bin_id_f,
                                reference_type="sdo_final_delivery",
                                reference_id=sdo.id,
                                uom_id=1,
                                created_by=current_user.id,
                            )

                        # Add to destination warehouse available_qty
                        await post_stock_ledger(
                            db,
                            item_id=mat_f.material_id,
                            warehouse_id=dest_wh_id,
                            transaction_type="transfer_in",
                            qty_in=qty_f,
                            batch_id=batch_id_f,
                            bin_id=bin_id_f,
                            reference_type="sdo_final_delivery",
                            reference_id=sdo.id,
                            uom_id=1,
                            created_by=current_user.id,
                        )
                    await db.flush()

                # Transition MaterialIssue status to "dispatched" for multi-level here (final ack leg)
                if mdo.material_issue_id:
                    from app.models.issue import MaterialIssue
                    mi_res = await db.execute(select(MaterialIssue).where(MaterialIssue.id == mdo.material_issue_id))
                    mi = mi_res.scalar_one_or_none()
                    if mi and mi.status != "dispatched":
                        mi.status = "dispatched"
                        mi.dispatched_at = datetime.now(timezone.utc)
                        db.add(mi)
            else:
                from app.api.v1.dispatch import process_dispatch_stock_deduction
                await process_dispatch_stock_deduction(db, disp, mdo.created_by or 1)
        except Exception as stock_err:
            import traceback
            traceback.print_exc()
            print(f"[WARNING] Stock movement failed for dispatch {disp.id}: {stock_err}")
            # Continue — the acknowledgement is still valid even if stock movement fails.

        # Notify destination warehouse users and MDO creator of final delivery
        try:
            from app.models.user import User as _FinalUser
            from app.models.user import UserWarehouse as _FinalUW

            # Notify destination warehouse users
            if mdo.destination_warehouse_id:
                dest_wh_user_res = await db.execute(
                    select(_FinalUser).join(_FinalUW, _FinalUW.user_id == _FinalUser.id)
                    .where(_FinalUW.warehouse_id == mdo.destination_warehouse_id)
                )
                for dw_user in dest_wh_user_res.scalars().all():
                    db.add(Notification(
                        user_id=dw_user.id,
                        title="Dispatch Delivered — Inventory Updated",
                        message=f"Dispatch {mdo.mdo_number} has been fully delivered and acknowledged by {current_user.username}. Stock has been credited to your warehouse.",
                        type="success",
                        module="logistics",
                        reference_type="MDO",
                        reference_id=mdo.id
                    ))

            # Notify MDO creator/dispatcher
            if mdo.created_by and mdo.created_by != current_user.id:
                db.add(Notification(
                    user_id=mdo.created_by,
                    title="Dispatch Delivery Confirmed",
                    message=f"Dispatch {mdo.mdo_number} has been successfully delivered and acknowledged at the destination. All inventory records have been updated.",
                    type="success",
                    module="logistics",
                    reference_type="MDO",
                    reference_id=mdo.id
                ))
        except Exception:
            pass

    await db.commit()
    return {"success": True, "message": "Custody leg acknowledgment processed successfully.", "is_last": is_last_leg}

@router.post("/mdo/{id}/approve")
async def approve_mdo(id: int, db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user)):
    res = await db.execute(select(LogisticsMainDispatchOrder).where(LogisticsMainDispatchOrder.id == id))
    mdo = res.scalar_one_or_none()
    if not mdo:
        raise HTTPException(404, "MDO not found")

    mdo.status = "APPROVED"
    mdo.approved_by = current_user.id
    mdo.approved_at = datetime.now(timezone.utc)
    db.add(mdo)

    # Activity Log & Notification
    db.add(ActivityLog(
        user_id=current_user.id,
        module="logistics",
        action="approve_mdo",
        entity_type="mdo",
        entity_id=mdo.id,
        description=f"Approved Main Dispatch Order {mdo.mdo_number} for carrier RFQ publishing."
    ))

    db.add(Notification(
        user_id=current_user.id,
        title="MDO Approved",
        message=f"MDO {mdo.mdo_number} was approved and is now ready for freight quotation bidding.",
        type="success",
        module="logistics",
        reference_type="MDO",
        reference_id=mdo.id
    ))

    await db.commit()
    return {"success": True, "message": f"MDO {mdo.mdo_number} approved successfully"}

# --- RFQ ENDPOINTS ---

@router.get("/rfq", response_model=List[RfqResponse])
async def get_rfqs(db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user)):
    res = await db.execute(
        select(LogisticsRfqMaster)
        .options(
            selectinload(LogisticsRfqMaster.mappings).joinedload(LogisticsRfqDispatchMapping.sdo).selectinload(LogisticsSubDispatchOrder.materials).joinedload(LogisticsDispatchMaterial.material),
            selectinload(LogisticsRfqMaster.invited_vendors).joinedload(LogisticsRfqVendor.vendor),
            selectinload(LogisticsRfqMaster.responses).selectinload(LogisticsRfqResponse.vehicles),
            selectinload(LogisticsRfqMaster.responses).selectinload(LogisticsRfqResponse.assignments).joinedload(LogisticsRfqResponseSdoAssignment.sdo),
            selectinload(LogisticsRfqMaster.responses).joinedload(LogisticsRfqResponse.vendor)
        )
        .order_by(LogisticsRfqMaster.id.desc())
    )
    rfqs = res.scalars().all()

    output = []
    for r in rfqs:
        rfq_res = RfqResponse(
            id=r.id,
            rfq_number=r.rfq_number,
            rfq_type=r.rfq_type.name if hasattr(r.rfq_type, "name") else r.rfq_type,
            mdo_id=r.mdo_id,
            mdo_number=None,
            title=r.title,
            description=r.description,
            issue_date=r.issue_date,
            response_deadline=r.response_deadline,
            expected_delivery_date=r.expected_delivery_date,
            total_estimated_weight_kg=float(r.total_estimated_weight_kg),
            total_estimated_volume_cft=float(r.total_estimated_volume_cft),
            vehicle_type_required=r.vehicle_type_required,
            payment_terms=r.payment_terms,
            advance_payment_percentage=float(r.advance_payment_percentage),
            insurance_required=r.insurance_required,
            status=r.status.name if hasattr(r.status, "name") else r.status,
            evaluation_criteria=r.evaluation_criteria,
            created_at=r.created_at,
            invited_vendors=[],
            responses=[],
            materials=[]
        )

        for mapping in r.mappings:
            if mapping.sdo and mapping.sdo.materials:
                for mat in mapping.sdo.materials:
                    rfq_res.materials.append(
                        DispatchMaterialResponse(
                            id=mat.id,
                            mdo_id=mat.mdo_id,
                            sdo_id=mat.sdo_id,
                            material_id=mat.material_id,
                            material_code=mat.material.item_code if mat.material else None,
                            material_name=mat.material.name if mat.material else None,
                            quantity=float(mat.quantity),
                            unit_of_measure=mat.unit_of_measure,
                            total_weight_kg=float(mat.total_weight_kg),
                            total_volume_cft=float(mat.total_volume_cft),
                            unit_price=float(mat.unit_price),
                            total_value=float(mat.total_value),
                            batch_number=mat.batch_number,
                            serial_numbers=mat.serial_numbers,
                            number_of_packages=mat.number_of_packages,
                            package_type=mat.package_type,
                            handling_instructions=mat.handling_instructions,
                            special_storage_condition=mat.material.special_storage_condition if mat.material else False,
                            storage_min_temp=float(mat.material.storage_min_temp) if (mat.material and mat.material.storage_min_temp is not None) else None,
                            storage_max_temp=float(mat.material.storage_max_temp) if (mat.material and mat.material.storage_max_temp is not None) else None,
                            storage_min_moisture=float(mat.material.storage_min_moisture) if (mat.material and mat.material.storage_min_moisture is not None) else None,
                            storage_max_moisture=float(mat.material.storage_max_moisture) if (mat.material and mat.material.storage_max_moisture is not None) else None,
                            storage_breakable=mat.material.storage_breakable if mat.material else False,
                            special_transport_condition=mat.material.special_transport_condition if mat.material else False,
                            transport_min_temp=float(mat.material.transport_min_temp) if (mat.material and mat.material.transport_min_temp is not None) else None,
                            transport_max_temp=float(mat.material.transport_max_temp) if (mat.material and mat.material.transport_max_temp is not None) else None,
                            transport_min_moisture=float(mat.material.transport_min_moisture) if (mat.material and mat.material.transport_min_moisture is not None) else None,
                            transport_max_moisture=float(mat.material.transport_max_moisture) if (mat.material and mat.material.transport_max_moisture is not None) else None,
                            transport_breakable=mat.material.transport_breakable if mat.material else False
                        )
                    )

        for iv in r.invited_vendors:
            rfq_res.invited_vendors.append(
                RfqVendorResponse(
                    id=iv.id,
                    rfq_id=iv.rfq_id,
                    vendor_id=iv.vendor_id,
                    vendor_name=iv.vendor.name if iv.vendor else None,
                    vendor_code=iv.vendor.vendor_code if iv.vendor else None,
                    invited_at=iv.invited_at,
                    response_status=iv.response_status.name if hasattr(iv.response_status, "name") else iv.response_status,
                    declined_at=iv.declined_at,
                    decline_reason=iv.decline_reason
                )
            )

        for resp in r.responses:
            resp_dict = RfqResponseQuoteResponse(
                id=resp.id,
                rfq_id=resp.rfq_id,
                vendor_id=resp.vendor_id,
                vendor_name=resp.vendor.name if resp.vendor else None,
                response_number=resp.response_number,
                response_date=resp.response_date,
                pricing_type=resp.pricing_type.name if hasattr(resp.pricing_type, "name") else resp.pricing_type,
                total_quoted_price=float(resp.total_quoted_price),
                advance_payment_percentage=float(resp.advance_payment_percentage),
                vendor_remarks=resp.vendor_remarks,
                status=resp.status.name if hasattr(resp.status, "name") else resp.status,
                evaluation_score=float(resp.evaluation_score) if resp.evaluation_score else None,
                is_selected=resp.is_selected,
                vehicles=[],
                assignments=[]
            )

            for v in resp.vehicles:
                resp_dict.vehicles.append(
                    RfqResponseVehicleResponse(
                        id=v.id,
                        response_id=v.response_id,
                        vehicle_number=v.vehicle_number,
                        vehicle_registration_no=v.vehicle_registration_no,
                        vehicle_type=v.vehicle_type,
                        vehicle_capacity_kg=float(v.vehicle_capacity_kg) if v.vehicle_capacity_kg else None,
                        vehicle_capacity_cft=float(v.vehicle_capacity_cft) if v.vehicle_capacity_cft else None,
                        driver_name=v.driver_name,
                        driver_mobile=v.driver_mobile,
                        driver_license_no=v.driver_license_no,
                        vehicle_base_price=float(v.vehicle_base_price),
                        vehicle_loading_charges=float(v.vehicle_loading_charges),
                        vehicle_unloading_charges=float(v.vehicle_unloading_charges),
                        detention_charges_per_hour=float(v.detention_charges_per_hour),
                        other_charges=float(v.other_charges),
                        total_vehicle_price=float(v.total_vehicle_price),
                        insurance_required=v.insurance_required,
                        insurance_cost=float(v.insurance_cost),
                        gps_enabled=v.gps_enabled
                    )
                )

            for a in resp.assignments:
                resp_dict.assignments.append(
                    SdoAssignmentResponse(
                        id=a.id,
                        response_id=a.response_id,
                        vehicle_response_id=a.vehicle_response_id,
                        sdo_id=a.sdo_id,
                        sdo_number=a.sdo.sdo_number if a.sdo else None,
                        sdo_quoted_price=float(a.sdo_quoted_price),
                        estimated_pickup_datetime=a.estimated_pickup_datetime,
                        estimated_delivery_datetime=a.estimated_delivery_datetime
                    )
                )

            rfq_res.responses.append(resp_dict)

        output.append(rfq_res)

    return output

@router.post("/rfq")
async def create_rfq(payload: RfqCreateSchema, db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user)):
    rfq_id_val = int(datetime.now().timestamp() * 1000) % 900000 + 100000
    rfq_num = f"RFQ-2026-{rfq_id_val}"

    # Calculate summaries from SDOs
    total_wt = 0.0
    total_vol = 0.0
    vehicle_req = "Truck"

    res_sdos = await db.execute(select(LogisticsSubDispatchOrder).where(LogisticsSubDispatchOrder.id.in_(payload.sdoIds)))
    sdos = res_sdos.scalars().all()
    for s in sdos:
        total_wt += float(s.estimated_weight_kg)
        total_vol += float(s.estimated_volume_cft)
        vehicle_req = s.vehicle_type_required

    # Parse Deadline
    deadline_dt = datetime.fromisoformat(payload.deadline.replace("Z", "+00:00"))

    # Parse optional expected delivery date
    expected_delivery_dt = None
    if payload.expected_delivery_date:
        try:
            expected_delivery_dt = datetime.fromisoformat(payload.expected_delivery_date.replace("Z", "+00:00"))
        except (ValueError, AttributeError):
            expected_delivery_dt = None

    new_rfq = LogisticsRfqMaster(
        rfq_number=rfq_num,
        rfq_type="MIXED" if len(payload.sdoIds) > 1 else "SDO",
        mdo_id=payload.mdoId,
        title=payload.title,
        description=payload.description,
        issue_date=datetime.now(timezone.utc),
        response_deadline=deadline_dt,
        expected_delivery_date=expected_delivery_dt,
        total_estimated_weight_kg=total_wt,
        total_estimated_volume_cft=total_vol,
        vehicle_type_required=payload.vehicle_type_required or vehicle_req,
        payment_terms=payload.paymentTerms,
        advance_payment_percentage=payload.advancePercentage,
        insurance_required=payload.insuranceRequired,
        evaluation_criteria={
            "price_weight": payload.criteriaPrice,
            "rating_weight": payload.criteriaRating,
            "timeline_weight": payload.criteriaTimeline
        },
        status="PUBLISHED",
        created_by=current_user.id
    )
    db.add(new_rfq)
    await db.flush()

    # Create SDO mappings
    for idx, s in enumerate(sdos):
        mapping = LogisticsRfqDispatchMapping(
            rfq_id=new_rfq.id,
            sdo_id=s.id,
            is_primary=(idx == 0),
            sequence_number=idx + 1,
            estimated_weight_kg=s.estimated_weight_kg,
            estimated_volume_cft=s.estimated_volume_cft,
            required_pickup_datetime=s.required_pickup_datetime,
            required_delivery_datetime=s.required_delivery_datetime,
            status="PENDING"
        )
        db.add(mapping)

        # Update SDO status
        s.status = "RFQ_SENT"
        db.add(s)

    # Update MDO status
    res_mdo = await db.execute(select(LogisticsMainDispatchOrder).where(LogisticsMainDispatchOrder.id == payload.mdoId))
    mdo = res_mdo.scalar_one_or_none()
    if mdo:
        mdo.status = "RFQ_IN_PROGRESS"
        db.add(mdo)

    # Invite Transporters
    for v_id in payload.invitedVendorIds:
        invite = LogisticsRfqVendor(
            rfq_id=new_rfq.id,
            vendor_id=v_id,
            invited_by=current_user.id,
            invitation_method="PORTAL",
            invitation_sent=True,
            response_status="PENDING"
        )
        db.add(invite)

        # Vendor Notification
        # (Usually in real app, we notify vendor account. For simulator, we insert notification with vendor_id)
        # Note: BHSPL Notification table uses standard user, but since transporters are simulated, we trigger standard notification.
        db.add(Notification(
            user_id=current_user.id,  # Admin sees it too
            title="Carrier Bid Invitation",
            message=f"Carrier invited to quote on B2B freight bid {rfq_num}. Weight: {total_wt:.1f} kg. Title: {payload.title}",
            type="info",
            module="logistics",
            reference_type="RFQ",
            reference_id=new_rfq.id
        ))

    db.add(ActivityLog(
        user_id=current_user.id,
        module="logistics",
        action="publish_rfq",
        entity_type="rfq",
        entity_id=new_rfq.id,
        description=f"Raised freight B2B bid {rfq_num} for mapping of {len(payload.sdoIds)} child shipments to {len(payload.invitedVendorIds)} transporters."
    ))

    await db.commit()
    return {"message": "RFQ published successfully", "rfq_id": new_rfq.id, "rfq_number": rfq_num}

@router.post("/rfq/{id}/quote")
async def submit_rfq_quote(id: int, payload: QuoteSubmit, db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user)):
    res_r = await db.execute(select(LogisticsRfqMaster).where(LogisticsRfqMaster.id == id))
    rfq = res_r.scalar_one_or_none()
    if not rfq:
        raise HTTPException(404, "RFQ not found")

    quote_id_val = int(datetime.now().timestamp() * 1000) % 900000 + 100000
    quote_num = f"QT-2026-{quote_id_val}"

    # Verify if transporter was invited
    res_v = await db.execute(select(LogisticsRfqVendor).where(LogisticsRfqVendor.rfq_id == id, LogisticsRfqVendor.vendor_id == payload.vendorId))
    vendor_invite = res_v.scalar_one_or_none()
    if vendor_invite:
        vendor_invite.response_status = "QUOTED"
        db.add(vendor_invite)

    # 1. Create RFQ Response
    new_resp = LogisticsRfqResponse(
        rfq_id=id,
        vendor_id=payload.vendorId,
        response_number=quote_num,
        pricing_type=payload.pricingType,
        total_quoted_price=payload.totalQuotedPrice,
        payment_terms=payload.paymentTerms,
        advance_payment_percentage=payload.advancePercentage,
        vendor_remarks=payload.remarks,
        status="SUBMITTED"
    )
    db.add(new_resp)
    await db.flush()

    for veh_in in payload.vehicles:
        # Create Vehicle details
        total_v_price = veh_in.basePrice + veh_in.loadingCharges + veh_in.unloadingCharges + veh_in.otherCharges
        new_veh = LogisticsRfqResponseVehicle(
            response_id=new_resp.id,
            vehicle_number=veh_in.registrationNo,
            vehicle_registration_no=veh_in.registrationNo,
            vehicle_type=veh_in.vehicleType,
            vehicle_capacity_kg=veh_in.capacityKg,
            vehicle_capacity_cft=veh_in.capacityCft,
            driver_name=veh_in.driverName,
            driver_mobile=veh_in.driverMobile,
            driver_license_no=veh_in.driverLicense,
            driver_license_expiry=date.today() + timedelta(days=365),
            availability_from=datetime.now(timezone.utc),
            vehicle_base_price=veh_in.basePrice,
            vehicle_loading_charges=veh_in.loadingCharges,
            vehicle_unloading_charges=veh_in.unloadingCharges,
            detention_charges_per_hour=veh_in.detentionCharges,
            other_charges=veh_in.otherCharges,
            total_vehicle_price=total_v_price,
            insurance_required=rfq.insurance_required,
            insurance_cost=total_v_price * 0.005,
            gps_enabled=veh_in.gpsEnabled
        )
        db.add(new_veh)
        await db.flush()

        # Create assignments
        for assign in veh_in.sdoAssignments:
            new_assign = LogisticsRfqResponseSdoAssignment(
                response_id=new_resp.id,
                vehicle_response_id=new_veh.id,
                sdo_id=assign.sdoId,
                sdo_quoted_price=assign.quotedPrice,
                estimated_pickup_datetime=datetime.fromisoformat(assign.pickupTime.replace("Z", "+00:00")),
                estimated_delivery_datetime=datetime.fromisoformat(assign.deliveryTime.replace("Z", "+00:00")),
                proposed_route="Standard Transit Mapping",
                estimated_distance_km=150.0,
                estimated_duration_hours=4.0
            )
            db.add(new_assign)

    # Score bid based on criteria (Simulate a harmonized evaluation score out of 100!)
    criteria = rfq.evaluation_criteria or {"price_weight": 40, "rating_weight": 30, "timeline_weight": 30}
    # Base score out of 100. Best pricing and 4.8 rating gives 95+. Unsafe gives 40.
    res_vendor = await db.execute(select(Vendor).where(Vendor.id == payload.vendorId))
    vendor = res_vendor.scalar_one_or_none()
    v_rating = float(vendor.rating or 4.0) if vendor else 4.0
    
    score = (float(v_rating) / 5.0) * criteria.get("rating_weight", 30)
    # Price score: lower is better
    price_score = (3500.0 / float(payload.totalQuotedPrice or 5000.0)) * criteria.get("price_weight", 40)
    score += min(price_score, criteria.get("price_weight", 40))
    score += criteria.get("timeline_weight", 30) * 0.9  # simulated timeline adherence
    
    new_resp.evaluation_score = min(score, 100.0)
    db.add(new_resp)

    db.add(ActivityLog(
        user_id=current_user.id,
        module="logistics",
        action="submit_quote",
        entity_type="rfq_response",
        entity_id=new_resp.id,
        description=f"Transporter submitted quote {quote_num} for RFQ {rfq.rfq_number}. Quoted Price: INR {payload.totalQuotedPrice:.2f}."
    ))

    db.add(Notification(
        user_id=rfq.created_by,
        title="Freight Bid Received",
        message=f"Quote {quote_num} received from carrier for RFQ {rfq.rfq_number}. Score: {score:.1f}/100.",
        type="success",
        module="logistics",
        reference_type="RFQ",
        reference_id=rfq.id
    ))

    await db.commit()
    return {"message": "Bid submitted successfully", "response_id": new_resp.id, "response_number": quote_num}

@router.post("/rfq/{id}/decline")
async def decline_rfq_invite(id: int, payload: DeclineRfqInvitation, db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user)):
    res_rv = await db.execute(select(LogisticsRfqVendor).where(LogisticsRfqVendor.rfq_id == id, LogisticsRfqVendor.vendor_id == payload.vendorId))
    invite = res_rv.scalar_one_or_none()
    if not invite:
        raise HTTPException(404, "Invitation not found")

    invite.response_status = "DECLINED"
    invite.declined_at = datetime.now(timezone.utc)
    invite.decline_reason = payload.reason
    db.add(invite)

    res_r = await db.execute(select(LogisticsRfqMaster).where(LogisticsRfqMaster.id == id))
    rfq = res_r.scalar_one_or_none()

    db.add(Notification(
        user_id=rfq.created_by if rfq else current_user.id,
        title="RFQ Invite Declined",
        message=f"Carrier declined RFQ {rfq.rfq_number if rfq else id}. Reason: {payload.reason}",
        type="warning",
        module="logistics",
        reference_type="RFQ",
        reference_id=id
    ))

    await db.commit()
    return {"success": True, "message": "Invitation declined"}

@router.post("/rfq/{id}/select")
async def select_winning_quotation(id: int, payload: AwardRfqQuote, db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user)):
    res_r = await db.execute(select(LogisticsRfqMaster).where(LogisticsRfqMaster.id == id))
    rfq = res_r.scalar_one_or_none()
    if not rfq:
        raise HTTPException(404, "RFQ not found")

    # Select bid
    res_resp = await db.execute(select(LogisticsRfqResponse).where(LogisticsRfqResponse.id == payload.responseId, LogisticsRfqResponse.rfq_id == id))
    winning_quote = res_resp.scalar_one_or_none()
    if not winning_quote:
        raise HTTPException(404, "Quotation not found")

    winning_quote.is_selected = True
    winning_quote.status = "SELECTED"
    winning_quote.selected_by = current_user.id
    winning_quote.selected_at = datetime.now(timezone.utc)
    winning_quote.selection_remarks = payload.remarks
    db.add(winning_quote)

    # Reject other quotes
    await db.execute(
        update(LogisticsRfqResponse)
        .where(LogisticsRfqResponse.rfq_id == id, LogisticsRfqResponse.id != payload.responseId)
        .values(status="REJECTED")
    )

    # Update RFQ status
    rfq.status = "CLOSED"
    rfq.closed_at = datetime.now(timezone.utc)
    rfq.closed_by = current_user.id
    rfq.closure_remarks = f"Awarded to carrier. Remarks: {payload.remarks}"
    db.add(rfq)

    # Create Service Order (SO)
    so_id_val = int(datetime.now().timestamp() * 1000) % 900000 + 100000
    so_num = f"SO-2026-{so_id_val}"

    new_so = LogisticsServiceOrder(
        so_number=so_num,
        rfq_id=rfq.id,
        response_id=winning_quote.id,
        vendor_id=winning_quote.vendor_id,
        mdo_id=rfq.mdo_id,
        so_type="INDIVIDUAL",
        total_order_value=winning_quote.total_quoted_price,
        payment_terms=winning_quote.payment_terms,
        advance_payment_percentage=winning_quote.advance_payment_percentage,
        advance_payment_amount=float(winning_quote.total_quoted_price) * (float(winning_quote.advance_payment_percentage or 0) / 100.0),
        expected_delivery_date=rfq.expected_delivery_date,
        status="CREATED",
        created_by=current_user.id
    )
    db.add(new_so)
    await db.flush()

    # Map SDO status and create vehicle tasks
    res_veh = await db.execute(select(LogisticsRfqResponseVehicle).where(LogisticsRfqResponseVehicle.response_id == winning_quote.id))
    vehicles = res_veh.scalars().all()

    for idx, v in enumerate(vehicles):
        new_so_veh = LogisticsServiceOrderVehicle(
            so_id=new_so.id,
            vehicle_response_id=v.id,
            vehicle_type=v.vehicle_type,
            vehicle_registration_no=v.vehicle_registration_no,
            driver_name=v.driver_name,
            driver_mobile=v.driver_mobile,
            driver_license_no=v.driver_license_no,
            vehicle_order_value=v.total_vehicle_price,
            vehicle_status="SCHEDULED"
        )
        db.add(new_so_veh)
        await db.flush()

        # Map SDOs assigned to this vehicle
        res_assign = await db.execute(select(LogisticsRfqResponseSdoAssignment).where(LogisticsRfqResponseSdoAssignment.vehicle_response_id == v.id))
        assignments = res_assign.scalars().all()

        for a in assignments:
            mapping = LogisticsServiceOrderSdoMapping(
                so_id=new_so.id,
                so_vehicle_id=new_so_veh.id,
                sdo_id=a.sdo_id,
                delivery_sequence=a.sequence_number,
                status="PENDING"
            )
            db.add(mapping)

            # Update SDO status
            res_sdo = await db.execute(select(LogisticsSubDispatchOrder).where(LogisticsSubDispatchOrder.id == a.sdo_id))
            sdo_obj = res_sdo.scalar_one_or_none()
            if sdo_obj:
                sdo_obj.status = "SO_CREATED"
                db.add(sdo_obj)

    # Update MDO status
    if rfq.mdo_id:
        res_m = await db.execute(select(LogisticsMainDispatchOrder).where(LogisticsMainDispatchOrder.id == rfq.mdo_id))
        mdo_obj = res_m.scalar_one_or_none()
        if mdo_obj:
            mdo_obj.status = "CONFIRMED"
            db.add(mdo_obj)

    db.add(ActivityLog(
        user_id=current_user.id,
        module="logistics",
        action="award_rfq",
        entity_type="rfq",
        entity_id=rfq.id,
        description=f"Closed RFQ {rfq.rfq_number} and auto-generated B2B logistics contract Service Order {so_num} awarded to winning carrier."
    ))

    db.add(Notification(
        user_id=current_user.id,
        title="Freight Bid Finalized",
        message=f"B2B freight Service Order {so_num} awarded successfully. Carrier must acknowledge contract to begin gate-in operations.",
        type="success",
        module="logistics",
        reference_type="SO",
        reference_id=new_so.id
    ))

    await db.commit()
    return {"message": "RFQ bid awarded successfully", "so_id": new_so.id, "so_number": so_num}

# --- SERVICE ORDER ENDPOINTS ---

@router.get("/so", response_model=List[ServiceOrderResponse])
async def get_service_orders(
    exclude_gated: bool = Query(False),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    query = (
        select(LogisticsServiceOrder)
        .options(
            selectinload(LogisticsServiceOrder.vehicles),
            selectinload(LogisticsServiceOrder.mappings).joinedload(LogisticsServiceOrderSdoMapping.sdo),
            joinedload(LogisticsServiceOrder.vendor),
            joinedload(LogisticsServiceOrder.rfq),
            joinedload(LogisticsServiceOrder.mdo).joinedload(LogisticsMainDispatchOrder.warehouse)
        )
    )
    if exclude_gated:
        from app.models.dispatch import GatePass
        gated_so_ids_subquery = select(GatePass.grn_id).where(GatePass.grn_id.is_not(None)).where(GatePass.status != "cancelled")
        query = query.where(LogisticsServiceOrder.id.notin_(gated_so_ids_subquery))

    res = await db.execute(query.order_by(LogisticsServiceOrder.id.desc()))
    sos = res.scalars().all()

    output = []
    for so in sos:
        so_dict = ServiceOrderResponse(
            id=so.id,
            so_number=so.so_number,
            rfq_id=so.rfq_id,
            rfq_number=so.rfq.rfq_number if so.rfq else None,
            response_id=so.response_id,
            vendor_id=so.vendor_id,
            vendor_name=so.vendor.name if so.vendor else None,
            mdo_id=so.mdo_id,
            warehouse_id=so.mdo.warehouse_id if so.mdo else None,
            warehouse_name=so.mdo.warehouse.name if so.mdo and so.mdo.warehouse else None,
            so_type=so.so_type.name if hasattr(so.so_type, "name") else so.so_type,
            total_order_value=float(so.total_order_value),
            payment_terms=so.payment_terms,
            advance_payment_percentage=float(so.advance_payment_percentage),
            advance_payment_amount=float(so.advance_payment_amount) if so.advance_payment_amount else None,
            advance_paid=so.advance_paid,
            status=so.status.name if hasattr(so.status, "name") else so.status,
            acknowledged_by_vendor=so.acknowledged_by_vendor,
            acknowledged_at=so.acknowledged_at,
            vendor_remarks=so.vendor_remarks,
            arrival_date=so.arrival_date,
            expected_delivery_date=so.expected_delivery_date,
            completed_at=so.completed_at,
            po_number=so.po_number,
            created_at=so.created_at,
            vehicles=[],
            mappings=[]
        )

        for v in so.vehicles:
            so_dict.vehicles.append(
                ServiceOrderVehicleResponse(
                    id=v.id,
                    so_id=v.so_id,
                    vehicle_type=v.vehicle_type,
                    vehicle_registration_no=v.vehicle_registration_no,
                    driver_name=v.driver_name,
                    driver_mobile=v.driver_mobile,
                    driver_license_no=v.driver_license_no,
                    vehicle_order_value=float(v.vehicle_order_value) if v.vehicle_order_value else None,
                    scheduled_pickup_datetime=v.scheduled_pickup_datetime,
                    scheduled_delivery_datetime=v.scheduled_delivery_datetime,
                    gate_entry_time=v.gate_entry_time,
                    gate_pass_number=v.gate_pass_number,
                    loading_bay_number=v.loading_bay_number,
                    loading_start_time=v.loading_start_time,
                    loading_end_time=v.loading_end_time,
                    actual_arrival_datetime=v.actual_arrival_datetime,
                    actual_departure_datetime=v.actual_departure_datetime,
                    actual_delivery_datetime=v.actual_delivery_datetime,
                    lr_number=v.lr_number,
                    lr_date=v.lr_date,
                    eway_bill_number=v.eway_bill_number,
                    eway_bill_expiry=v.eway_bill_expiry,
                    pod_received=v.pod_received,
                    pod_received_at=v.pod_received_at,
                    pod_received_by=v.pod_received_by,
                    pod_document_url=v.pod_document_url,
                    gps_tracking_url=v.gps_tracking_url,
                    vehicle_status=v.vehicle_status.name if hasattr(v.vehicle_status, "name") else v.vehicle_status,
                    has_issues=v.has_issues,
                    issue_description=v.issue_description,
                    delay_reason=v.delay_reason,
                    delay_minutes=v.delay_minutes
                )
            )

        for m in so.mappings:
            so_dict.mappings.append(
                ServiceOrderSdoMappingResponse(
                    id=m.id,
                    so_id=m.so_id,
                    so_vehicle_id=m.so_vehicle_id,
                    sdo_id=m.sdo_id,
                    sdo_number=m.sdo.sdo_number if m.sdo else None,
                    delivery_sequence=m.delivery_sequence,
                    status=m.status.name if hasattr(m.status, "name") else m.status,
                    delivered_at=m.delivered_at,
                    delivered_to=m.delivered_to,
                    delivery_remarks=m.delivery_remarks
                )
            )

        output.append(so_dict)

    return output

@router.post("/so/{id}/acknowledge")
async def acknowledge_so(id: int, payload: SoAcknowledge, db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user)):
    res = await db.execute(select(LogisticsServiceOrder).where(LogisticsServiceOrder.id == id))
    so = res.scalar_one_or_none()
    if not so:
        raise HTTPException(404, "Service Order not found")

    action = (payload.action or "accept").lower()
    if action == "reject":
        so.status = "REJECTED"
        so.acknowledged_by_vendor = False
        action_desc = "rejected"
    else:
        so.status = "ACCEPTED"
        so.acknowledged_by_vendor = True
        so.acknowledged_at = datetime.now(timezone.utc)
        so.arrival_date = payload.arrival_date
        action_desc = "accepted"

    so.vendor_remarks = payload.remarks
    db.add(so)

    db.add(ActivityLog(
        user_id=current_user.id,
        module="logistics",
        action="acknowledge_so",
        entity_type="so",
        entity_id=so.id,
        description=f"Carrier {action_desc} contract Service Order {so.so_number}."
    ))

    db.add(Notification(
        user_id=so.created_by,
        title=f"SO Contract {action_desc.capitalize()}",
        message=f"Carrier {action_desc} B2B contract {so.so_number}. Remarks: {payload.remarks or 'None'}",
        type="success" if action == "accept" else "warning",
        module="logistics",
        reference_type="SO",
        reference_id=so.id
    ))

    await db.commit()
    return {"success": True, "message": f"Service order contract {action_desc} successfully"}

@router.post("/so/vehicle/{vehicle_id}/status")
async def update_so_vehicle_status(vehicle_id: int, payload: VehicleStatusUpdate, db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user)):
    res = await db.execute(select(LogisticsServiceOrderVehicle).where(LogisticsServiceOrderVehicle.id == vehicle_id))
    v = res.scalar_one_or_none()
    if not v:
        raise HTTPException(404, "Vehicle not found")

    # Update SO status on first movement
    res_so = await db.execute(select(LogisticsServiceOrder).where(LogisticsServiceOrder.id == v.so_id))
    so = res_so.scalar_one_or_none()
    if so and so.status == "ACCEPTED":
        so.status = "IN_PROGRESS"
        db.add(so)

    # Pre-resolve mdo so it is available globally in the status transitions
    mdo = None
    if so and so.mdo_id:
        res_mdo = await db.execute(select(LogisticsMainDispatchOrder).where(LogisticsMainDispatchOrder.id == so.mdo_id))
        mdo = res_mdo.scalar_one_or_none()

    next_status = payload.nextStatus
    v.vehicle_status = next_status

    if next_status == "GATE_IN":
        v.gate_pass_number = payload.gatePassNumber
        v.gate_entry_time = datetime.now(timezone.utc)
        v.gate_entry_by = current_user.id
        v.actual_arrival_datetime = datetime.now(timezone.utc)

        # Update associated GatePass status to gate_in
        if payload.gatePassNumber:
            from app.models.dispatch import GatePass
            gp_res = await db.execute(select(GatePass).where(GatePass.gate_pass_number == payload.gatePassNumber.strip()))
            gp = gp_res.scalar_one_or_none()
            if gp:
                gp.status = "gate_in"
                gp.gate_in_time = datetime.now(timezone.utc)
                db.add(gp)

    elif next_status == "LOADING":
        v.loading_bay_number = payload.loadingBayNumber or "BAY-M-01"
        v.loading_supervisor = current_user.id
        v.loading_start_time = datetime.now(timezone.utc)

        # Occupy Bay
        await db.execute(
            update(LogisticsLoadingBay)
            .where(LogisticsLoadingBay.bay_number == v.loading_bay_number)
            .values(current_status="OCCUPIED")
        )

    elif next_status == "GATE_OUT":
        v.loading_end_time = datetime.now(timezone.utc)
        v.actual_departure_datetime = datetime.now(timezone.utc)
        v.lr_number = payload.lrNumber or f"LR-{int(datetime.now().timestamp()) % 100000}"
        v.eway_bill_number = payload.ewayBillNumber or f"EW-{int(datetime.now().timestamp()) % 1000000}"
        v.eway_bill_expiry = datetime.now(timezone.utc) + timedelta(days=3)
        if payload.gateOutPassNumber:
            v.gate_out_pass_number = payload.gateOutPassNumber

        # Free Bay
        if v.loading_bay_number:
            await db.execute(
                update(LogisticsLoadingBay)
                .where(LogisticsLoadingBay.bay_number == v.loading_bay_number)
                .values(current_status="AVAILABLE")
            )

        # Update MDO/SDO mapping
        res_maps = await db.execute(select(LogisticsServiceOrderSdoMapping).where(LogisticsServiceOrderSdoMapping.so_vehicle_id == v.id))
        mappings = res_maps.scalars().all()
        for m in mappings:
            m.status = "LOADED"
            db.add(m)

    elif next_status == "IN_TRANSIT":
        # Simply update geo-tracking simulated coords
        v.current_location_lat = 19.1234
        v.current_location_lng = 72.8910
        v.last_location_update = datetime.now(timezone.utc)
        v.gps_tracking_url = f"https://maps.google.com/?q={v.current_location_lat},{v.current_location_lng}"
        if payload.gateOutPassNumber:
            v.gate_out_pass_number = payload.gateOutPassNumber

        # Update associated GatePass status to gate_out
        target_gp_num = v.gate_out_pass_number or v.gate_pass_number
        if target_gp_num:
            from app.models.dispatch import GatePass
            gp_res = await db.execute(select(GatePass).where(GatePass.gate_pass_number == target_gp_num.strip()))
            gp = gp_res.scalar_one_or_none()
            if gp:
                gp.status = "gate_out"
                gp.gate_out_time = datetime.now(timezone.utc)
                db.add(gp)

        res_maps = await db.execute(select(LogisticsServiceOrderSdoMapping).where(LogisticsServiceOrderSdoMapping.so_vehicle_id == v.id))
        mappings = res_maps.scalars().all()
        for m in mappings:
            m.status = "IN_TRANSIT"
            db.add(m)

            res_sdo = await db.execute(select(LogisticsSubDispatchOrder).where(LogisticsSubDispatchOrder.id == m.sdo_id))
            sdo = res_sdo.scalar_one_or_none()
            if sdo and sdo.status != "IN_TRANSIT":
                sdo.status = "IN_TRANSIT"
                db.add(sdo)

                # Check if multi-level intermediate leg handover (sequence > 1) to shift stock
                if mdo and mdo.dispatch_mode == "multi-level":
                    if sdo.sequence_number > 1:
                        try:
                            from app.api.v1.dispatch import get_warehouse_for_position
                            from app.services.stock_service import _get_or_create_balance
                            from decimal import Decimal

                            sender_wh_id = await get_warehouse_for_position(db, sdo.custodian_position_id)
                            if sender_wh_id:
                                res_mats = await db.execute(
                                    select(LogisticsDispatchMaterial).where(LogisticsDispatchMaterial.mdo_id == mdo.id)
                                )
                                mats = res_mats.scalars().all()

                                for mat in mats:
                                    batch_id = None
                                    bin_id = None
                                    if mdo.material_issue_id:
                                        from app.models.issue import MaterialIssueItem
                                        mi_item_res = await db.execute(
                                            select(MaterialIssueItem).where(
                                                MaterialIssueItem.issue_id == mdo.material_issue_id,
                                                MaterialIssueItem.item_id == mat.material_id
                                            ).limit(1)
                                        )
                                        mi_item = mi_item_res.scalar_one_or_none()
                                        if mi_item:
                                            batch_id = mi_item.batch_id
                                            bin_id = mi_item.bin_id

                                    qty = Decimal(str(mat.quantity))

                                    # Shift available_qty → transit_qty at sender warehouse
                                    sender_balance = await _get_or_create_balance(
                                        db,
                                        item_id=mat.material_id,
                                        warehouse_id=sender_wh_id,
                                        bin_id=bin_id,
                                        batch_id=batch_id,
                                        lock=True,
                                    )
                                    sender_balance.available_qty = max(
                                        Decimal("0"),
                                        (sender_balance.available_qty or Decimal("0")) - qty
                                    )
                                    sender_balance.transit_qty = (sender_balance.transit_qty or Decimal("0")) + qty
                                await db.flush()
                        except Exception as handover_err:
                            import logging
                            logging.getLogger(__name__).exception("Failed to perform intermediate 3PL handover transit stock transfer")

                    # Dynamic creation of the next SDO leg (similar to handover_sdo)
                    try:
                        from app.api.v1.dispatch import get_destination_position_id
                        from app.api.v1.logistics import resolve_mdo_project_id, resolve_indent_creator_position, build_logistics_custody_chain
                        dest_pos_id = await get_destination_position_id(db, mdo.destination_warehouse_id, mdo.destination_user_id)
                        project_id = await resolve_mdo_project_id(db, mdo.indent_id, mdo.material_issue_id)
                        starting_pos_id = await resolve_indent_creator_position(db, mdo.indent_id, mdo.material_issue_id)

                        chain_data = []
                        if project_id and starting_pos_id:
                            chain_data = await build_logistics_custody_chain(db, project_id, starting_pos_id, dest_pos_id)
                        chain = [entry["position"] for entry in chain_data if entry.get("can_approve", False) or entry.get("is_destination", False)]

                        if sdo.sequence_number < len(chain):
                            next_pos = chain[sdo.sequence_number]
                            # Avoid creating duplicate next leg SDOs
                            existing_next_res = await db.execute(
                                select(LogisticsSubDispatchOrder).where(
                                    LogisticsSubDispatchOrder.mdo_id == mdo.id,
                                    LogisticsSubDispatchOrder.sequence_number == sdo.sequence_number + 1
                                )
                            )
                            if not existing_next_res.scalar_one_or_none():
                                sdo_num = await generate_logistics_sequence_number(
                                    db,
                                    prefix="SDO",
                                    document_type="sub_dispatch_order",
                                )
                                next_sdo = LogisticsSubDispatchOrder(
                                    sdo_number=sdo_num,
                                    mdo_id=mdo.id,
                                    route_id=None,
                                    route_name=f"Custody Leg {sdo.sequence_number + 1}",
                                    vehicle_type_required="Truck",
                                    estimated_distance_km=100.0,
                                    required_pickup_datetime=datetime.now(timezone.utc),
                                    required_delivery_datetime=datetime.now(timezone.utc) + timedelta(days=2),
                                    loading_time_minutes=30,
                                    unloading_time_minutes=30,
                                    requires_loading_helper=False,
                                    status="PENDING",
                                    custodian_position_id=next_pos.id,
                                    sequence_number=sdo.sequence_number + 1,
                                    estimated_weight_kg=sdo.estimated_weight_kg,
                                    estimated_volume_cft=sdo.estimated_volume_cft
                                )
                                db.add(next_sdo)
                                await db.flush()
                    except Exception as next_leg_err:
                        import logging
                        logging.getLogger(__name__).exception("Failed to dynamically generate next SDO leg for 3PL dispatch")

        if so and so.mdo_id:
            await db.execute(
                update(LogisticsMainDispatchOrder)
                .where(LogisticsMainDispatchOrder.id == so.mdo_id)
                .values(status="IN_TRANSIT")
            )
            await db.flush()
            from app.api.v1.dispatch import sync_mdos_to_dispatches
            await sync_mdos_to_dispatches(db)

    elif next_status == "TRANSPORTER_ACKNOWLEDGED":
        v.actual_delivery_datetime = datetime.now(timezone.utc)

    elif next_status == "DELIVERY_ACKNOWLEDGED":
        v.actual_delivery_datetime = datetime.now(timezone.utc)
        v.pod_received = True
        v.pod_received_at = datetime.now(timezone.utc)
        v.pod_received_by = payload.podReceivedBy or "Manager Inward"
        v.pod_document_url = payload.podDocumentUrl or "/pod_signature_received.pdf"
        v.feedback = payload.feedbackText
        v.vendor_rating = payload.ratingValue or 4.5
        v.delay_minutes = payload.delayMinutes or 0
        v.delay_reason = payload.delayReasonText

        # Update MDO/SDO mapping
        res_maps = await db.execute(select(LogisticsServiceOrderSdoMapping).where(LogisticsServiceOrderSdoMapping.so_vehicle_id == v.id))
        mappings = res_maps.scalars().all()
        for m in mappings:
            m.status = "DELIVERED"
            m.delivered_at = datetime.now(timezone.utc)
            m.delivered_to = v.pod_received_by
            m.delivery_remarks = v.feedback
            db.add(m)

            res_sdo = await db.execute(select(LogisticsSubDispatchOrder).where(LogisticsSubDispatchOrder.id == m.sdo_id))
            sdo = res_sdo.scalar_one_or_none()
            if sdo:
                # Check if multi-level and not final leg to set to ACKNOWLEDGED and run stock transit receive
                is_intermediate = False
                if mdo and mdo.dispatch_mode == "multi-level":
                    res_mdo_sdos = await db.execute(
                        select(LogisticsSubDispatchOrder).where(LogisticsSubDispatchOrder.mdo_id == mdo.id)
                    )
                    mdo_sdos = res_mdo_sdos.scalars().all()
                    max_seq = max((s.sequence_number for s in mdo_sdos), default=1)
                    if sdo.sequence_number < max_seq:
                        is_intermediate = True

                if is_intermediate:
                    sdo.status = "ACKNOWLEDGED"
                    db.add(sdo)

                    # Perform stock receive transit movement (analogous to sdo_receive)
                    try:
                        from app.api.v1.dispatch import get_warehouse_for_position
                        from app.services.stock_service import _get_or_create_balance, post_stock_ledger
                        from decimal import Decimal

                        # Resolve previous warehouse
                        prev_wh_id = mdo.warehouse_id
                        if sdo.sequence_number > 1:
                            prev_sdo_res = await db.execute(
                                select(LogisticsSubDispatchOrder).where(
                                    LogisticsSubDispatchOrder.mdo_id == mdo.id,
                                    LogisticsSubDispatchOrder.sequence_number == sdo.sequence_number - 1
                                ).order_by(LogisticsSubDispatchOrder.id.desc()).limit(1)
                            )
                            prev_sdo = prev_sdo_res.scalar_one_or_none()
                            if prev_sdo and prev_sdo.custodian_position_id:
                                resolved_prev_wh = await get_warehouse_for_position(db, prev_sdo.custodian_position_id)
                                if resolved_prev_wh:
                                    prev_wh_id = resolved_prev_wh
                        
                        # Resolve current warehouse
                        curr_wh_id = await get_warehouse_for_position(db, sdo.custodian_position_id) or mdo.destination_warehouse_id

                        if prev_wh_id and curr_wh_id:
                            res_mats = await db.execute(
                                select(LogisticsDispatchMaterial).where(LogisticsDispatchMaterial.mdo_id == mdo.id)
                            )
                            mats = res_mats.scalars().all()

                            for mat in mats:
                                batch_id = None
                                bin_id = None
                                if mdo.material_issue_id:
                                    from app.models.issue import MaterialIssueItem
                                    mi_item_res = await db.execute(
                                        select(MaterialIssueItem).where(
                                            MaterialIssueItem.issue_id == mdo.material_issue_id,
                                            MaterialIssueItem.item_id == mat.material_id
                                        ).limit(1)
                                    )
                                    mi_item = mi_item_res.scalar_one_or_none()
                                    if mi_item:
                                        batch_id = mi_item.batch_id
                                        bin_id = mi_item.bin_id

                                qty = Decimal(str(mat.quantity))

                                if prev_wh_id != curr_wh_id:
                                    prev_balance = await _get_or_create_balance(
                                        db,
                                        item_id=mat.material_id,
                                        warehouse_id=prev_wh_id,
                                        bin_id=bin_id,
                                        batch_id=batch_id,
                                        lock=True,
                                    )
                                    prev_balance.transit_qty = max(Decimal("0"), (prev_balance.transit_qty or Decimal("0")) - qty)
                                    
                                    await post_stock_ledger(
                                        db,
                                        item_id=mat.material_id,
                                        warehouse_id=prev_wh_id,
                                        transaction_type="transfer_out",
                                        qty_out=qty,
                                        batch_id=batch_id,
                                        bin_id=bin_id,
                                        reference_type="sub_dispatch_order",
                                        reference_id=sdo.id,
                                        uom_id=1,
                                        created_by=current_user.id,
                                    )

                                await post_stock_ledger(
                                    db,
                                    item_id=mat.material_id,
                                    warehouse_id=curr_wh_id,
                                    transaction_type="transfer_in",
                                    qty_in=qty,
                                    batch_id=batch_id,
                                    bin_id=bin_id,
                                    reference_type="sub_dispatch_order",
                                    reference_id=sdo.id,
                                    uom_id=1,
                                    created_by=current_user.id,
                                )
                            await db.flush()
                    except Exception as receive_err:
                        import logging
                        logging.getLogger(__name__).exception("Failed to perform intermediate 3PL receive transit stock transfer")
                else:
                    sdo.status = "DELIVERED"
                    db.add(sdo)

        # Check if all vehicles/SDOs in SO are completed
        res_all_v = await db.execute(select(LogisticsServiceOrderVehicle).where(LogisticsServiceOrderVehicle.so_id == v.so_id))
        all_vehs = res_all_v.scalars().all()
        all_completed = all(vh.id == v.id or vh.vehicle_status == "DELIVERY_ACKNOWLEDGED" for vh in all_vehs)
        if all_completed and so:
            so.status = "COMPLETED"
            so.completed_at = datetime.now(timezone.utc)
            db.add(so)

            if so.mdo_id:
                # In multi-level dispatch, only complete the MDO if this is the final leg
                res_mdo = await db.execute(select(LogisticsMainDispatchOrder).where(LogisticsMainDispatchOrder.id == so.mdo_id))
                mdo = res_mdo.scalar_one_or_none()
                is_mdo_completed = True
                
                if mdo and mdo.dispatch_mode == "multi-level":
                    # Check if any SDO in this Service Order is not the last leg
                    for m in mappings:
                        res_sdo = await db.execute(select(LogisticsSubDispatchOrder).where(LogisticsSubDispatchOrder.id == m.sdo_id))
                        current_sdo = res_sdo.scalar_one_or_none()
                        if current_sdo:
                            # Safely check if this is an intermediate leg based on the SDOs associated with this MDO in database
                            res_mdo_sdos = await db.execute(
                                select(LogisticsSubDispatchOrder)
                                .where(LogisticsSubDispatchOrder.mdo_id == mdo.id)
                            )
                            mdo_sdos = res_mdo_sdos.scalars().all()
                            max_seq = max((s.sequence_number for s in mdo_sdos), default=1)
                            if current_sdo.sequence_number < max_seq:
                                is_mdo_completed = False
                                break

                            try:
                                from app.api.v1.dispatch import get_destination_position_id
                                from app.api.v1.logistics import resolve_mdo_project_id, resolve_indent_creator_position, build_logistics_custody_chain
                                dest_pos_id = await get_destination_position_id(db, mdo.destination_warehouse_id, mdo.destination_user_id)
                                project_id = await resolve_mdo_project_id(db, mdo.indent_id, mdo.material_issue_id)
                                starting_pos_id = await resolve_indent_creator_position(db, mdo.indent_id, mdo.material_issue_id)

                                chain_data = []
                                if project_id and starting_pos_id:
                                    chain_data = await build_logistics_custody_chain(db, project_id, starting_pos_id, dest_pos_id)
                                chain = [entry["position"] for entry in chain_data if entry.get("can_approve", False) or entry.get("is_destination", False)]

                                if chain and current_sdo.sequence_number < len(chain):
                                    is_mdo_completed = False
                                    break
                            except Exception:
                                pass

                if is_mdo_completed:
                    await db.execute(
                        update(LogisticsMainDispatchOrder)
                        .where(LogisticsMainDispatchOrder.id == so.mdo_id)
                        .values(status="COMPLETED")
                    )
                    await db.flush()
                    from app.api.v1.dispatch import sync_mdos_to_dispatches
                    await sync_mdos_to_dispatches(db)

    db.add(v)

    db.add(ActivityLog(
        user_id=current_user.id,
        module="logistics",
        action="vehicle_status",
        entity_type="so_vehicle",
        entity_id=v.id,
        description=f"Vehicle registration {v.vehicle_registration_no} status changed to {next_status}."
    ))

    db.add(Notification(
        user_id=so.created_by if so else current_user.id,
        title="Vehicle Gating Update",
        message=f"Vehicle {v.vehicle_registration_no} updated to status {next_status}.",
        type="info",
        module="logistics",
        reference_type="SO",
        reference_id=v.so_id
    ))

    await db.commit()
    return {"success": True, "message": f"Vehicle status updated to {next_status}"}

@router.post("/so/vehicle/{vehicle_id}/issue")
async def log_so_vehicle_issue(vehicle_id: int, payload: VehicleIssueLog, db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user)):
    res = await db.execute(select(LogisticsServiceOrderVehicle).where(LogisticsServiceOrderVehicle.id == vehicle_id))
    v = res.scalar_one_or_none()
    if not v:
        raise HTTPException(404, "Vehicle not found")

    v.has_issues = True
    v.issue_description = payload.issueDescription
    db.add(v)

    res_so = await db.execute(select(LogisticsServiceOrder).where(LogisticsServiceOrder.id == v.so_id))
    so = res_so.scalar_one_or_none()

    db.add(Notification(
        user_id=so.created_by if so else current_user.id,
        title="Transit/Loading Alert",
        message=f"Vehicle {v.vehicle_registration_no} logged an issue: {payload.issueDescription}",
        type="error",
        module="logistics",
        reference_type="SO",
        reference_id=v.so_id
    ))

    await db.commit()
    return {"success": True, "message": "Issue logged successfully"}

# =====================================================================
# CARRIER (transport vendor) CRUD — coordinator-side master maintenance
# =====================================================================

import re as _re


def _slugify_carrier_code(name: str) -> str:
    base = _re.sub(r"[^A-Za-z0-9]+", "-", (name or "").strip().upper()).strip("-")
    return f"VND-{base[:20]}" if base else f"VND-CARRIER-{int(datetime.now().timestamp()) % 10000}"


@router.get("/carriers")
async def list_carriers(
    include_inactive: bool = False,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    await ensure_logistics_schema(db)
    q = select(Vendor).where((Vendor.is_transport_vendor == True) | (Vendor.vendor_type == "transport"))  # noqa: E712
    if not include_inactive:
        q = q.where(Vendor.is_active == True)  # noqa: E712
    res = await db.execute(q.order_by(Vendor.name.asc()))
    carriers = res.scalars().all()

    # Look up which ones already have a login account
    res_lu = await db.execute(
        select(CarrierUser.vendor_id, CarrierUser.id, CarrierUser.username, CarrierUser.is_active, CarrierUser.last_login)
        .where(CarrierUser.vendor_id.in_([c.id for c in carriers] or [-1]))
    )
    login_by_vendor = {
        row[0]: {"id": row[1], "username": row[2], "is_active": row[3], "last_login": row[4]}
        for row in res_lu.all()
    }

    return [
        {
            "vendor_id": c.id,
            "vendor_code": c.vendor_code,
            "vendor_name": c.name,
            "contact_person": c.contact_person,
            "mobile": c.phone,
            "email": c.email,
            "address": c.address_line1,
            "rating": float(c.rating or 0.0),
            "is_active": c.is_active,
            "login": login_by_vendor.get(c.id),
        }
        for c in carriers
    ]


@router.post("/carriers", status_code=201)
async def create_carrier(
    payload: CarrierCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_any_role(
        "super_admin", "admin", "logistics_manager", "warehouse_manager", "purchase_manager",
    )),
):
    code = (payload.vendor_code or "").strip() or _slugify_carrier_code(payload.name)

    # Ensure code is unique
    res = await db.execute(select(Vendor).where(Vendor.vendor_code == code))
    if res.scalar_one_or_none():
        raise HTTPException(409, f"Carrier code '{code}' already exists")

    new_v = Vendor(
        vendor_code=code,
        name=payload.name,
        contact_person=payload.contact_person,
        email=payload.email,
        phone=payload.phone,
        address_line1=payload.address,
        rating=payload.rating or 4.0,
        payment_terms_days=payload.payment_terms_days or 30,
        is_transport_vendor=True,
        vendor_type="transport",
        is_active=True,
    )
    db.add(new_v)
    await db.flush()
    db.add(ActivityLog(
        user_id=current_user.id,
        module="logistics",
        action="create_carrier",
        entity_type="vendor",
        entity_id=new_v.id,
        description=f"Added transport carrier {new_v.name} ({code}).",
    ))
    await db.commit()
    return {"vendor_id": new_v.id, "vendor_code": code, "message": "Carrier added"}


@router.put("/carriers/{vendor_id}")
async def update_carrier(
    vendor_id: int,
    payload: CarrierUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_any_role(
        "super_admin", "admin", "logistics_manager", "warehouse_manager", "purchase_manager",
    )),
):
    res = await db.execute(select(Vendor).where(Vendor.id == vendor_id))
    v = res.scalar_one_or_none()
    if not v:
        raise HTTPException(404, "Carrier not found")
    data = payload.model_dump(exclude_none=True)
    if "address" in data:
        v.address_line1 = data.pop("address")
    for k, val in data.items():
        setattr(v, k, val)
    db.add(v)
    db.add(ActivityLog(
        user_id=current_user.id,
        module="logistics",
        action="update_carrier",
        entity_type="vendor",
        entity_id=v.id,
        description=f"Updated transport carrier {v.name}.",
    ))
    await db.commit()
    return {"success": True, "message": "Carrier updated"}


@router.delete("/carriers/{vendor_id}")
async def deactivate_carrier(
    vendor_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_any_role(
        "super_admin", "admin", "logistics_manager", "warehouse_manager", "purchase_manager",
    )),
):
    res = await db.execute(select(Vendor).where(Vendor.id == vendor_id))
    v = res.scalar_one_or_none()
    if not v:
        raise HTTPException(404, "Carrier not found")
    v.is_active = False
    # Cascade-deactivate the carrier login (if any) so they can no longer sign in.
    res_cu = await db.execute(select(CarrierUser).where(CarrierUser.vendor_id == vendor_id))
    for cu in res_cu.scalars().all():
        cu.is_active = False
    db.add(ActivityLog(
        user_id=current_user.id,
        module="logistics",
        action="deactivate_carrier",
        entity_type="vendor",
        entity_id=v.id,
        description=f"Deactivated transport carrier {v.name}.",
    ))
    await db.commit()
    return {"success": True, "message": "Carrier deactivated"}


@router.post("/carriers/{vendor_id}/login", status_code=201)
async def create_carrier_login(
    vendor_id: int,
    payload: CarrierLoginCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_any_role(
        "super_admin", "admin", "logistics_manager", "warehouse_manager", "purchase_manager",
    )),
):
    res = await db.execute(select(Vendor).where(Vendor.id == vendor_id))
    v = res.scalar_one_or_none()
    if not v:
        raise HTTPException(404, "Carrier not found")
    if not v.is_active:
        raise HTTPException(400, "Cannot create a login for an inactive carrier")

    # One login per carrier (extension would let multiple users; keep simple here).
    res_existing = await db.execute(select(CarrierUser).where(CarrierUser.vendor_id == vendor_id))
    if res_existing.scalar_one_or_none():
        raise HTTPException(409, "This carrier already has a portal login. Use Reset Password instead.")

    # Username uniqueness
    res_u = await db.execute(select(CarrierUser).where(CarrierUser.username == payload.username))
    if res_u.scalar_one_or_none():
        raise HTTPException(409, f"Username '{payload.username}' is already taken")

    cu = CarrierUser(
        vendor_id=vendor_id,
        username=payload.username,
        email=payload.email,
        password_hash=hash_password(payload.password),
        full_name=payload.full_name or v.contact_person,
        phone=payload.phone or v.phone,
        is_active=True,
        must_change_password=True,
        password_changed_at=datetime.now(timezone.utc),
        created_by=current_user.id,
    )
    db.add(cu)
    await db.flush()
    db.add(ActivityLog(
        user_id=current_user.id,
        module="logistics",
        action="create_carrier_login",
        entity_type="carrier_user",
        entity_id=cu.id,
        description=f"Created portal login '{cu.username}' for carrier {v.name}.",
    ))
    await db.commit()
    return {
        "id": cu.id,
        "username": cu.username,
        "vendor_id": vendor_id,
        "message": "Carrier login created",
    }


@router.put("/carriers/{vendor_id}/login")
async def update_carrier_login(
    vendor_id: int,
    payload: CarrierLoginUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_any_role(
        "super_admin", "admin", "logistics_manager", "warehouse_manager", "purchase_manager",
    )),
):
    res = await db.execute(select(CarrierUser).where(CarrierUser.vendor_id == vendor_id))
    cu = res.scalar_one_or_none()
    if not cu:
        raise HTTPException(404, "This carrier has no login")
    data = payload.model_dump(exclude_none=True)
    if "new_password" in data:
        cu.password_hash = hash_password(data.pop("new_password"))
        cu.password_changed_at = datetime.now(timezone.utc)
        cu.must_change_password = True
        cu.failed_login_attempts = 0
        cu.locked_until = None
    for k, val in data.items():
        setattr(cu, k, val)
    db.add(cu)
    db.add(ActivityLog(
        user_id=current_user.id,
        module="logistics",
        action="update_carrier_login",
        entity_type="carrier_user",
        entity_id=cu.id,
        description=f"Updated login '{cu.username}'.",
    ))
    await db.commit()
    return {"success": True, "message": "Carrier login updated"}


@router.post("/reset")
async def reset_logistics_database(db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user)):
    # Clear all transaction tables
    await db.execute(delete(LogisticsServiceOrderSdoMapping))
    await db.execute(delete(LogisticsServiceOrderVehicle))
    await db.execute(delete(LogisticsServiceOrder))
    await db.execute(delete(LogisticsRfqResponseSdoAssignment))
    await db.execute(delete(LogisticsRfqResponseVehicle))
    await db.execute(delete(LogisticsRfqResponse))
    await db.execute(delete(LogisticsRfqVendor))
    await db.execute(delete(LogisticsRfqDispatchMapping))
    await db.execute(delete(LogisticsRfqMaster))
    await db.execute(delete(LogisticsDispatchMaterial))
    await db.execute(delete(LogisticsSdoDestination))
    await db.execute(delete(LogisticsSubDispatchOrder))
    await db.execute(delete(LogisticsMainDispatchOrder))

    # Clear Master tables and re-seed
    await db.execute(delete(LogisticsLoadingBay))
    await db.execute(delete(LogisticsRouteLocation))
    await db.execute(delete(LogisticsRoute))
    await db.execute(delete(LogisticsLocation))

    await db.flush()

    # Re-bootstrap seeds
    await bootstrap_logistics_data(db)

    db.add(ActivityLog(
        user_id=current_user.id,
        module="logistics",
        action="reset_db",
        entity_type="system",
        entity_id=1,
        description="Wiped logistics B2B transaction records and restored default route mapping seeds."
    ))

    await db.commit()
    return {"success": True, "message": "Logistics transactions cleared and master seeds successfully restored."}


# --- HANDOVER ENDPOINTS ---

@router.post("/handover", response_model=DispatchHandoverResponse)
async def create_handover(payload: DispatchHandoverCreate, db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user)):
    res_d = await db.execute(select(LogisticsMainDispatchOrder).where(LogisticsMainDispatchOrder.id == payload.dispatch_id))
    mdo = res_d.scalar_one_or_none()
    if not mdo:
        raise HTTPException(404, "Dispatch Plan not found")

    import random
    handover_val = int(datetime.now().timestamp() * 1000) % 900000 + 100000
    hnd_no = f"HND-2026-{handover_val}"
    otp_val = str(random.randint(100000, 999999))

    new_handover = DispatchHandover(
        dispatch_id=payload.dispatch_id,
        handover_no=hnd_no,
        handover_type=payload.handover_type,
        handed_over_by_entity_id=current_user.id,
        received_by_name=payload.received_by_name,
        received_by_phone=payload.received_by_phone,
        transporter_id=payload.transporter_id,
        vehicle_no=payload.vehicle_no,
        driver_name=payload.driver_name,
        driver_phone=payload.driver_phone,
        courier_name=payload.courier_name,
        awb_no=payload.awb_no,
        handover_otp=otp_val,
        otp_verified=True,  # Bypassed OTP verification
        handover_document=payload.handover_document,
        remarks=payload.remarks,
        handover_time=datetime.now(timezone.utc),
        status="HANDED_OVER"
    )
    db.add(new_handover)

    # Transition Dispatch Status to IN_TRANSIT directly for non-third-party types to trigger instant stock deductions
    if payload.handover_type in ("own vehicle", "COURIER", "IN_PERSON"):
        mdo.status = "IN_TRANSIT"
    else:
        mdo.status = "DISPATCHED"
    db.add(mdo)

    # Activity Log & Notification
    db.add(ActivityLog(
        user_id=current_user.id,
        module="logistics",
        action="create_handover",
        entity_type="handover",
        entity_id=mdo.id,
        description=f"Initialized handover {hnd_no} (Type: {payload.handover_type}) for Dispatch {mdo.mdo_number}. Stock sync triggered."
    ))

    db.add(Notification(
        user_id=current_user.id,
        title="Handover Confirmed",
        message=f"Handover {hnd_no} created and dispatched for {mdo.mdo_number}.",
        type="success",
        module="logistics",
        reference_type="MDO",
        reference_id=mdo.id
    ))

    await db.flush()
    if payload.handover_type in ("own vehicle", "COURIER", "IN_PERSON"):
        from app.api.v1.dispatch import sync_mdos_to_dispatches
        await sync_mdos_to_dispatches(db)

    await db.commit()

    res_h = await db.execute(
        select(DispatchHandover)
        .where(DispatchHandover.id == new_handover.id)
        .options(joinedload(DispatchHandover.transporter))
    )
    return res_h.scalar_one()


@router.post("/handover/{id}/verify-otp", response_model=DispatchHandoverResponse)
async def verify_handover_otp(id: int, payload: DispatchHandoverVerifyOtp, db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user)):
    res_h = await db.execute(
        select(DispatchHandover)
        .where(DispatchHandover.id == id)
        .options(joinedload(DispatchHandover.dispatch))
    )
    handover = res_h.scalar_one_or_none()
    if not handover:
        raise HTTPException(404, "Handover not found")

    if handover.handover_otp != payload.otp:
        raise HTTPException(400, "Invalid OTP provided.")

    handover.otp_verified = True
    handover.status = "HANDED_OVER"
    db.add(handover)

    db.add(ActivityLog(
        user_id=current_user.id,
        module="logistics",
        action="verify_handover",
        entity_type="handover",
        entity_id=handover.dispatch_id,
        description=f"Handover {handover.handover_no} successfully verified via OTP."
    ))

    db.add(Notification(
        user_id=current_user.id,
        title="Handover Confirmed",
        message=f"Handover {handover.handover_no} verified successfully.",
        type="success",
        module="logistics",
        reference_type="MDO",
        reference_id=handover.dispatch_id
    ))

    await db.commit()

    # Re-run query to load relationship for response
    res_h2 = await db.execute(
        select(DispatchHandover)
        .where(DispatchHandover.id == id)
        .options(joinedload(DispatchHandover.transporter))
    )
    return res_h2.scalar_one()


@router.get("/handover/{dispatch_id}", response_model=Optional[DispatchHandoverResponse])
async def get_handover(dispatch_id: int, db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user)):
    res_h = await db.execute(
        select(DispatchHandover)
        .where(DispatchHandover.dispatch_id == dispatch_id)
        .options(joinedload(DispatchHandover.transporter))
    )
    return res_h.scalar_one_or_none()


@router.post("/mdo/{id}/transit")
async def mark_mdo_in_transit(id: int, db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user)):
    res = await db.execute(select(LogisticsMainDispatchOrder).where(LogisticsMainDispatchOrder.id == id))
    mdo = res.scalar_one_or_none()
    if not mdo:
        raise HTTPException(404, "Dispatch Plan not found")

    mdo.status = "IN_TRANSIT"
    db.add(mdo)

    db.add(ActivityLog(
        user_id=current_user.id,
        module="logistics",
        action="mdo_in_transit",
        entity_type="dispatch",
        entity_id=mdo.id,
        description=f"Dispatch package {mdo.mdo_number} marked IN TRANSIT."
    ))

    # Sync standard dispatches and trigger stock deduction immediately
    await db.flush()
    from app.api.v1.dispatch import sync_mdos_to_dispatches
    await sync_mdos_to_dispatches(db)

    await db.commit()
    return {"success": True, "message": "Dispatch plan status updated to IN TRANSIT"}


@router.post("/mdo/{id}/deliver")
async def deliver_mdo(
    id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    res = await db.execute(
        select(LogisticsMainDispatchOrder)
        .options(selectinload(LogisticsMainDispatchOrder.sdos))
        .where(LogisticsMainDispatchOrder.id == id)
    )
    mdo = res.scalar_one_or_none()
    if not mdo:
        raise HTTPException(404, "Dispatch Plan not found")

    if mdo.dispatch_type == "THIRD_PARTY":
        raise HTTPException(400, "Third-party dispatches must be delivered via carrier portal service order gating workflow.")

    if mdo.status != "IN_TRANSIT":
        raise HTTPException(400, f"Cannot deliver dispatch in '{mdo.status}' status. It must be 'IN_TRANSIT'.")

    mdo.status = "COMPLETED"
    
    # Also update child sub-dispatch orders (SDOs) status to DELIVERED
    for sdo in mdo.sdos:
        sdo.status = "DELIVERED"
        db.add(sdo)

    db.add(mdo)

    db.add(ActivityLog(
        user_id=current_user.id,
        module="logistics",
        action="mdo_delivered",
        entity_type="dispatch",
        entity_id=mdo.id,
        description=f"Non-third-party dispatch plan {mdo.mdo_number} marked as COMPLETED/DELIVERED."
    ))

    db.add(Notification(
        user_id=current_user.id,
        title="Dispatch Delivered",
        message=f"Dispatch plan {mdo.mdo_number} is completed and marked as delivered.",
        type="success",
        module="logistics",
        reference_type="MDO",
        reference_id=mdo.id
    ))

    # Sync back to standard dispatch orders so they transition to 'delivered'
    from app.api.v1.dispatch import sync_mdos_to_dispatches
    await db.flush()
    await sync_mdos_to_dispatches(db)

    await db.commit()
    return {"success": True, "message": "Dispatch order marked as completed/delivered successfully."}


@router.post("/mdo/{id}/acknowledge")
async def acknowledge_mdo(id: int, db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user)):
    res = await db.execute(select(LogisticsMainDispatchOrder).where(LogisticsMainDispatchOrder.id == id))
    mdo = res.scalar_one_or_none()
    if not mdo:
        raise HTTPException(404, "Dispatch Plan not found")

    mdo.status = "ACKNOWLEDGED"
    db.add(mdo)
    await db.flush()

    # Sync MDO to DispatchOrder first so we have the DispatchOrder and sync the status to 'acknowledged'
    from app.api.v1.dispatch import sync_mdos_to_dispatches
    await sync_mdos_to_dispatches(db)

    # Trigger auto acknowledgement merge!
    from app.services.scm_integration import auto_acknowledge_scm_dispatch
    await auto_acknowledge_scm_dispatch(db, mdo_id=mdo.id, current_user_id=current_user.id)

    db.add(ActivityLog(
        user_id=current_user.id,
        module="logistics",
        action="mdo_acknowledged",
        entity_type="dispatch",
        entity_id=mdo.id,
        description=f"Dispatch package {mdo.mdo_number} delivery ACKNOWLEDGED."
    ))

    await db.commit()
    return {"success": True, "message": "Dispatch plan delivery successfully acknowledged and SCM records synced."}
