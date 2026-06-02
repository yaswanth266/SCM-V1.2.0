from fastapi import APIRouter, Depends, HTTPException, status, Query
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, update, delete, func, text
from sqlalchemy.orm import selectinload, joinedload
from datetime import datetime, timezone, date, timedelta
from typing import List, Dict, Any, Optional

from app.database import get_db
from app.utils.dependencies import get_current_user
from app.models.user import User
from app.models.master import Item, Vendor
from app.models.warehouse import Warehouse
from app.models.system import Notification, ActivityLog
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
    DispatchHandoverCreate, DispatchHandoverResponse, DispatchHandoverVerifyOtp
)

router = APIRouter()

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

    # Dynamic SCM enum updates for MySQL
    try:
        await conn.execute(text("""
            ALTER TABLE logistics_main_dispatch_orders 
            MODIFY COLUMN status ENUM('DRAFT', 'APPROVED', 'RFQ_IN_PROGRESS', 'CONFIRMED', 'DISPATCHED', 'IN_TRANSIT', 'COMPLETED', 'ACKNOWLEDGED', 'CANCELLED') 
            NOT NULL DEFAULT 'DRAFT'
        """))
    except Exception as e:
        print(f"[SCM Schema Sync] Skipping status alter or already applied: {e}")


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
    res = await db.execute(
        select(LogisticsMainDispatchOrder)
        .options(
            selectinload(LogisticsMainDispatchOrder.sdos).selectinload(LogisticsSubDispatchOrder.destinations).joinedload(LogisticsSdoDestination.location),
            selectinload(LogisticsMainDispatchOrder.sdos).selectinload(LogisticsSubDispatchOrder.materials).joinedload(LogisticsDispatchMaterial.material),
            selectinload(LogisticsMainDispatchOrder.handover).joinedload(DispatchHandover.transporter),
            joinedload(LogisticsMainDispatchOrder.warehouse),
            joinedload(LogisticsMainDispatchOrder.creator)
        )
        .order_by(LogisticsMainDispatchOrder.id.desc())
    )
    mdos = res.scalars().all()

    output = []
    for m in mdos:
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
            indent_id=m.indent_id,
            destination_warehouse_id=m.destination_warehouse_id,
            delivery_address=m.delivery_address,
            e_challan=m.e_challan,
            waybill=m.waybill,
            dispatch_type=m.dispatch_type,
            handover=m.handover,  # Pydantic maps relationship dynamically
            sdos=[]
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
                status=s.status.name if hasattr(s.status, "name") else s.status,
                created_at=s.created_at,
                destinations=[],
                materials=[]
            )

            for d in s.destinations:
                s_dict.destinations.append(
                    SdoDestinationResponse(
                        id=d.id,
                        sdo_id=d.sdo_id,
                        location_id=d.location_id,
                        location_name=d.location.location_name if d.location else None,
                        location_code=d.location.location_code if d.location else None,
                        sequence_number=d.sequence_number,
                        estimated_arrival_datetime=d.estimated_arrival_datetime,
                        delivery_contact_person=d.delivery_contact_person,
                        delivery_contact_mobile=d.delivery_contact_mobile,
                        actual_arrival_datetime=d.actual_arrival_datetime,
                        actual_departure_datetime=d.actual_departure_datetime,
                        pod_received=d.pod_received,
                        pod_received_by=d.pod_received_by,
                        pod_received_at=d.pod_received_at,
                        pod_document_url=d.pod_document_url,
                        status=d.status.name if hasattr(d.status, "name") else d.status
                    )
                )

            for mat in s.materials:
                s_dict.materials.append(
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
                        handling_instructions=mat.handling_instructions
                    )
                )

            m_dict.sdos.append(s_dict)
        output.append(m_dict)

    return output


@router.post("/mdo")
async def create_mdo(payload: MdoCreate, db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user)):
    mdo_id_val = int(datetime.now().timestamp() * 1000) % 900000 + 100000
    mdo_num = f"MDO-2026-{mdo_id_val}"

    # Calculate MDO summaries
    tot_items = 0
    tot_weight = 0.0
    tot_volume = 0.0
    tot_value = 0.0

    # Auto-approve immediately if NOT third_party dispatch (since Own Vehicle, Courier, In-Person bypass RFQ)
    initial_status = "APPROVED" if payload.dispatch_type != "THIRD_PARTY" else "DRAFT"

    first_delivery_date = date.today() + timedelta(days=2)
    if payload.sdos:
        try:
            first_delivery_date = datetime.fromisoformat(payload.sdos[0].deliveryDate.replace("Z", "+00:00")).date()
        except Exception:
            pass

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
        delivery_address=payload.delivery_address,
        e_challan=payload.e_challan,
        waybill=payload.waybill,
        dispatch_type=payload.dispatch_type or "THIRD_PARTY"
    )
    db.add(new_mdo)
    await db.flush()

    for sdo_in in payload.sdos:
        # Resolve route to get distance & name
        route_name = "Custom Segment Route"
        vehicle_req = "Truck"
        distance = 100.0
        if sdo_in.routeId:
            res_r = await db.execute(select(LogisticsRoute).where(LogisticsRoute.id == sdo_in.routeId))
            route_obj = res_r.scalar_one_or_none()
            if route_obj:
                route_name = route_obj.route_name
                vehicle_req = route_obj.recommended_vehicle_type
                distance = float(route_obj.estimated_distance_km)

        # Compute SDO totals
        sdo_weight = 0.0
        sdo_volume = 0.0

        sdo_id_val = int(datetime.now().timestamp() * 1000 + 1) % 900000 + 100000
        new_sdo = LogisticsSubDispatchOrder(
            sdo_number=f"SDO-2026-{sdo_id_val}",
            mdo_id=new_mdo.id,
            route_id=sdo_in.routeId,
            route_name=route_name,
            vehicle_type_required=vehicle_req,
            estimated_distance_km=distance,
            required_pickup_datetime=datetime.fromisoformat(sdo_in.pickupDate.replace("Z", "+00:00")),
            required_delivery_datetime=datetime.fromisoformat(sdo_in.deliveryDate.replace("Z", "+00:00")),
            loading_time_minutes=sdo_in.loadingTime,
            unloading_time_minutes=sdo_in.unloadingTime,
            requires_loading_helper=sdo_in.helperRequired,
            special_requirements=sdo_in.specialReqs,
            status="PENDING"
        )
        db.add(new_sdo)
        await db.flush()

        # Add destinations
        for dest in sdo_in.destinations:
            new_dest = LogisticsSdoDestination(
                sdo_id=new_sdo.id,
                location_id=dest.locationId,
                sequence_number=dest.seq,
                estimated_arrival_datetime=datetime.fromisoformat(sdo_in.deliveryDate.replace("Z", "+00:00")),
                delivery_contact_person=dest.contactPerson,
                delivery_contact_mobile=dest.contactMobile,
                status="PENDING"
            )
            db.add(new_dest)

        # Add materials
        for mat in sdo_in.materials:
            tot_items += 1
            wt = mat.qty * 10.0  # Simulated wt per unit
            vol = mat.qty * 0.5  # Simulated vol per unit
            val = mat.qty * 1200.0  # Simulated price
            sdo_weight += wt
            sdo_volume += vol

            tot_weight += wt
            tot_volume += vol
            tot_value += val

            new_mat = LogisticsDispatchMaterial(
                mdo_id=new_mdo.id,
                sdo_id=new_sdo.id,
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

        # Update SDO weight and volume
        new_sdo.estimated_weight_kg = sdo_weight
        new_sdo.estimated_volume_cft = sdo_volume
        db.add(new_sdo)

    new_mdo.total_material_items = tot_items
    new_mdo.total_weight_kg = tot_weight
    new_mdo.total_volume_cft = tot_volume
    new_mdo.total_value = tot_value
    db.add(new_mdo)

    # Activity Log
    db.add(ActivityLog(
        user_id=current_user.id,
        module="logistics",
        action="create_mdo",
        entity_type="mdo",
        entity_id=new_mdo.id,
        description=f"Created Main Dispatch Order {mdo_num} containing {len(payload.sdos)} child dispatches."
    ))

    # Notification
    db.add(Notification(
        user_id=current_user.id,
        title="Draft MDO Initialized",
        message=f"Main Dispatch Order {mdo_num} has been successfully created as a draft.",
        type="info",
        module="logistics",
        reference_type="MDO",
        reference_id=new_mdo.id
    ))

    await db.commit()
    return {"message": "MDO created successfully", "mdo_id": new_mdo.id, "mdo_number": mdo_num}

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
            selectinload(LogisticsRfqMaster.mappings).joinedload(LogisticsRfqDispatchMapping.sdo),
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
            responses=[]
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
        vehicle_type_required=vehicle_req,
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

    so.acknowledged_by_vendor = True
    so.acknowledged_at = datetime.now(timezone.utc)
    so.arrival_date = payload.arrival_date
    so.vendor_remarks = payload.remarks
    so.status = "ACKNOWLEDGED"
    db.add(so)

    db.add(ActivityLog(
        user_id=current_user.id,
        module="logistics",
        action="acknowledge_so",
        entity_type="so",
        entity_id=so.id,
        description=f"Carrier acknowledged contract Service Order {so.so_number}."
    ))

    db.add(Notification(
        user_id=so.created_by,
        title="SO Acknowledged",
        message=f"Carrier acknowledged B2B contract {so.so_number}. Vehicles are scheduled for dispatch gating.",
        type="success",
        module="logistics",
        reference_type="SO",
        reference_id=so.id
    ))

    await db.commit()
    return {"success": True, "message": "Service order acknowledged successfully"}

@router.post("/so/vehicle/{vehicle_id}/status")
async def update_so_vehicle_status(vehicle_id: int, payload: VehicleStatusUpdate, db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user)):
    res = await db.execute(select(LogisticsServiceOrderVehicle).where(LogisticsServiceOrderVehicle.id == vehicle_id))
    v = res.scalar_one_or_none()
    if not v:
        raise HTTPException(404, "Vehicle not found")

    # Update SO status on first movement
    res_so = await db.execute(select(LogisticsServiceOrder).where(LogisticsServiceOrder.id == v.so_id))
    so = res_so.scalar_one_or_none()
    if so and so.status == "ACKNOWLEDGED":
        so.status = "IN_PROGRESS"
        db.add(so)

    next_status = payload.nextStatus
    if next_status == "DISPATCHED":
        v.vehicle_status = "IN_TRANSIT"
    else:
        v.vehicle_status = next_status

    if next_status == "ARRIVED":
        v.gate_pass_number = payload.gatePassNumber
        v.gate_entry_time = datetime.now(timezone.utc)
        v.gate_entry_by = current_user.id
        v.actual_arrival_datetime = datetime.now(timezone.utc)

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

    elif next_status == "DISPATCHED":
        v.loading_end_time = datetime.now(timezone.utc)
        v.actual_departure_datetime = datetime.now(timezone.utc)
        v.lr_number = payload.lrNumber or f"LR-{int(datetime.now().timestamp()) % 100000}"
        v.eway_bill_number = payload.ewayBillNumber or f"EW-{int(datetime.now().timestamp()) % 1000000}"
        v.eway_bill_expiry = datetime.now(timezone.utc) + timedelta(days=3)

        # Initialize geo-tracking simulated coords
        v.current_location_lat = 19.1234
        v.current_location_lng = 72.8910
        v.last_location_update = datetime.now(timezone.utc)
        v.gps_tracking_url = f"https://maps.google.com/?q={v.current_location_lat},{v.current_location_lng}"

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

            res_sdo = await db.execute(select(LogisticsSubDispatchOrder).where(LogisticsSubDispatchOrder.id == m.sdo_id))
            sdo = res_sdo.scalar_one_or_none()
            if sdo:
                sdo.status = "IN_TRANSIT"
                db.add(sdo)

        if so and so.mdo_id:
            await db.execute(
                update(LogisticsMainDispatchOrder)
                .where(LogisticsMainDispatchOrder.id == so.mdo_id)
                .values(status="IN_TRANSIT")
            )
            await db.flush()
            from app.api.v1.dispatch import sync_mdos_to_dispatches
            await sync_mdos_to_dispatches(db)

    elif next_status == "IN_TRANSIT":
        # Simply update geo-tracking simulated coords
        v.current_location_lat = 19.1234
        v.current_location_lng = 72.8910
        v.last_location_update = datetime.now(timezone.utc)
        v.gps_tracking_url = f"https://maps.google.com/?q={v.current_location_lat},{v.current_location_lng}"

        res_maps = await db.execute(select(LogisticsServiceOrderSdoMapping).where(LogisticsServiceOrderSdoMapping.so_vehicle_id == v.id))
        mappings = res_maps.scalars().all()
        for m in mappings:
            m.status = "IN_TRANSIT"
            db.add(m)

    elif next_status == "DELIVERED":
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
                sdo.status = "DELIVERED"
                db.add(sdo)

        # Check if all vehicles/SDOs in SO are completed
        res_all_v = await db.execute(select(LogisticsServiceOrderVehicle).where(LogisticsServiceOrderVehicle.so_id == v.so_id))
        all_vehs = res_all_v.scalars().all()
        all_completed = all(vh.id == v.id or vh.vehicle_status == "DELIVERED" for vh in all_vehs)
        if all_completed and so:
            so.status = "COMPLETED"
            so.completed_at = datetime.now(timezone.utc)
            db.add(so)

            if so.mdo_id:
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

