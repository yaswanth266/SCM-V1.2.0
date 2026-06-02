from datetime import datetime, timezone, timedelta, date
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload, joinedload

from app.database import get_db
from app.models.carrier import CarrierUser
from app.models.master import Vendor
from app.models.system import Notification, ActivityLog
from app.models.logistics import (
    LogisticsRfqMaster, LogisticsRfqVendor, LogisticsRfqResponse,
    LogisticsRfqResponseVehicle, LogisticsRfqResponseSdoAssignment,
    LogisticsRfqDispatchMapping, LogisticsSubDispatchOrder,
    LogisticsServiceOrder, LogisticsServiceOrderVehicle, LogisticsServiceOrderSdoMapping,
)
from app.schemas.carrier_auth import CarrierQuoteSubmit, CarrierDeclineRfq
from app.schemas.logistics import SoAcknowledge, VehicleIssueLog
from app.utils.dependencies import get_current_carrier_user

router = APIRouter()


@router.get("/rfqs")
async def carrier_list_rfqs(
    db: AsyncSession = Depends(get_db),
    current_carrier: CarrierUser = Depends(get_current_carrier_user),
):
    """List RFQs the logged-in carrier was invited to. Carriers can ONLY
    see RFQs they were invited to and never see other carriers' quotes."""
    vendor_id = current_carrier.vendor_id
    res = await db.execute(
        select(LogisticsRfqMaster)
        .join(LogisticsRfqVendor, LogisticsRfqVendor.rfq_id == LogisticsRfqMaster.id)
        .where(LogisticsRfqVendor.vendor_id == vendor_id)
        .options(
            selectinload(LogisticsRfqMaster.invited_vendors),
            selectinload(LogisticsRfqMaster.mappings).joinedload(LogisticsRfqDispatchMapping.sdo),
            selectinload(LogisticsRfqMaster.responses).selectinload(LogisticsRfqResponse.vehicles),
        )
        .order_by(LogisticsRfqMaster.id.desc())
    )
    rfqs = res.scalars().unique().all()

    output = []
    for r in rfqs:
        my_invite = next((iv for iv in r.invited_vendors if iv.vendor_id == vendor_id), None)
        # Only return THIS carrier's own quote — never others'.
        my_quote = next((q for q in r.responses if q.vendor_id == vendor_id), None)
        my_quote_dict = None
        if my_quote:
            my_quote_dict = {
                "id": my_quote.id,
                "response_number": my_quote.response_number,
                "total_quoted_price": float(my_quote.total_quoted_price),
                "advance_payment_percentage": float(my_quote.advance_payment_percentage or 0),
                "payment_terms": my_quote.payment_terms,
                "vendor_remarks": my_quote.vendor_remarks,
                "status": my_quote.status.name if hasattr(my_quote.status, "name") else my_quote.status,
                "is_selected": my_quote.is_selected,
                "evaluation_score": float(my_quote.evaluation_score) if my_quote.evaluation_score else None,
                "vehicles": [
                    {
                        "id": v.id,
                        "registration_no": v.vehicle_registration_no,
                        "vehicle_type": v.vehicle_type,
                        "driver_name": v.driver_name,
                        "driver_mobile": v.driver_mobile,
                        "driver_license_no": v.driver_license_no,
                    }
                    for v in my_quote.vehicles
                ],
            }

        output.append({
            "id": r.id,
            "rfq_number": r.rfq_number,
            "title": r.title,
            "description": r.description,
            "issue_date": r.issue_date,
            "response_deadline": r.response_deadline,
            "total_estimated_weight_kg": float(r.total_estimated_weight_kg or 0),
            "total_estimated_volume_cft": float(r.total_estimated_volume_cft or 0),
            "vehicle_type_required": r.vehicle_type_required,
            "payment_terms": r.payment_terms,
            "advance_payment_percentage": float(r.advance_payment_percentage or 0),
            "insurance_required": r.insurance_required,
            "status": r.status.name if hasattr(r.status, "name") else r.status,
            "expected_delivery_date": r.expected_delivery_date,
            "invitation": {
                "id": my_invite.id,
                "response_status": my_invite.response_status.name if hasattr(my_invite.response_status, "name") else my_invite.response_status,
                "declined_at": my_invite.declined_at,
                "decline_reason": my_invite.decline_reason,
            } if my_invite else None,
            "my_quote": my_quote_dict,
            "sdo_count": len(r.mappings or []),
        })
    return output


def _carrier_can_modify_rfq(rfq: LogisticsRfqMaster) -> bool:
    """A carrier can submit/edit a quote only while the RFQ is published
    and not already awarded/closed."""
    status_val = rfq.status.name if hasattr(rfq.status, "name") else rfq.status
    return status_val == "PUBLISHED"


@router.post("/rfqs/{rfq_id}/quote")
async def carrier_submit_or_update_quote(
    rfq_id: int,
    payload: CarrierQuoteSubmit,
    db: AsyncSession = Depends(get_db),
    current_carrier: CarrierUser = Depends(get_current_carrier_user),
):
    """Carrier-side submit OR update quote. Refused after RFQ is awarded."""
    vendor_id = current_carrier.vendor_id

    res_r = await db.execute(
        select(LogisticsRfqMaster)
        .where(LogisticsRfqMaster.id == rfq_id)
        .options(selectinload(LogisticsRfqMaster.mappings))
    )
    rfq = res_r.scalar_one_or_none()
    if not rfq:
        raise HTTPException(404, "RFQ not found")

    if not _carrier_can_modify_rfq(rfq):
        raise HTTPException(400, "This RFQ is closed and quotes can no longer be edited.")

    # Verify carrier was invited
    res_iv = await db.execute(
        select(LogisticsRfqVendor).where(
            LogisticsRfqVendor.rfq_id == rfq_id, LogisticsRfqVendor.vendor_id == vendor_id
        )
    )
    invite = res_iv.scalar_one_or_none()
    if not invite:
        raise HTTPException(403, "You were not invited to this RFQ")

    invite_status = invite.response_status.name if hasattr(invite.response_status, "name") else invite.response_status
    if invite_status == "DECLINED":
        raise HTTPException(400, "You have already declined this invitation")

    # Find existing quote for this carrier (edit) or create new one
    res_q = await db.execute(
        select(LogisticsRfqResponse).where(
            LogisticsRfqResponse.rfq_id == rfq_id,
            LogisticsRfqResponse.vendor_id == vendor_id,
        )
        .options(selectinload(LogisticsRfqResponse.vehicles), selectinload(LogisticsRfqResponse.assignments))
    )
    existing = res_q.scalar_one_or_none()

    if existing:
        existing_status = existing.status.name if hasattr(existing.status, "name") else existing.status
        if existing_status in ("SELECTED", "REJECTED"):
            raise HTTPException(400, "This quote was already finalised and cannot be edited.")

        existing.total_quoted_price = payload.totalQuotedPrice
        existing.payment_terms = payload.paymentTerms or existing.payment_terms
        existing.advance_payment_percentage = payload.advancePercentage or 0
        existing.vendor_remarks = payload.remarks
        existing.response_date = datetime.now(timezone.utc)

        # Update primary vehicle (carriers in this UI just edit one fleet)
        existing_veh = existing.vehicles[0] if existing.vehicles else None
        if existing_veh:
            existing_veh.vehicle_registration_no = payload.registrationNo or existing_veh.vehicle_registration_no
            existing_veh.vehicle_number = payload.registrationNo or existing_veh.vehicle_number
            existing_veh.vehicle_type = payload.vehicleType or existing_veh.vehicle_type
            existing_veh.driver_name = payload.driverName or existing_veh.driver_name
            existing_veh.driver_mobile = payload.driverMobile or existing_veh.driver_mobile
            existing_veh.driver_license_no = payload.driverLicense or existing_veh.driver_license_no
            existing_veh.vehicle_capacity_kg = payload.capacityKg
            existing_veh.vehicle_capacity_cft = payload.capacityCft
            existing_veh.vehicle_base_price = payload.totalQuotedPrice
            existing_veh.total_vehicle_price = payload.totalQuotedPrice
            existing_veh.gps_enabled = payload.gpsEnabled
        # Recompute simple eval score
        res_v = await db.execute(select(Vendor).where(Vendor.id == vendor_id))
        vendor = res_v.scalar_one_or_none()
        v_rating = float(vendor.rating or 4.0) if vendor else 4.0
        criteria = rfq.evaluation_criteria or {"price_weight": 40, "rating_weight": 30, "timeline_weight": 30}
        score = (v_rating / 5.0) * criteria.get("rating_weight", 30)
        price_score = (3500.0 / float(payload.totalQuotedPrice or 5000.0)) * criteria.get("price_weight", 40)
        score += min(price_score, criteria.get("price_weight", 40))
        score += criteria.get("timeline_weight", 30) * 0.9
        existing.evaluation_score = min(score, 100.0)

        db.add(ActivityLog(
            user_id=None,
            module="logistics",
            action="carrier_update_quote",
            entity_type="rfq_response",
            entity_id=existing.id,
            description=f"Carrier user {current_carrier.username} updated quote {existing.response_number} for RFQ {rfq.rfq_number}.",
        ))
        db.add(Notification(
            user_id=rfq.created_by,
            title="Carrier updated freight bid",
            message=f"{current_carrier.vendor.name if current_carrier.vendor else 'Carrier'} updated their quote on RFQ {rfq.rfq_number} to ₹{payload.totalQuotedPrice:,.0f}.",
            type="info",
            module="logistics",
            reference_type="RFQ",
            reference_id=rfq.id,
        ))
        await db.commit()
        return {"message": "Quote updated", "response_id": existing.id, "response_number": existing.response_number}

    # ===== Create new quote =====
    quote_id_val = int(datetime.now().timestamp() * 1000) % 900000 + 100000
    quote_num = f"QT-2026-{quote_id_val}"

    new_resp = LogisticsRfqResponse(
        rfq_id=rfq_id,
        vendor_id=vendor_id,
        response_number=quote_num,
        pricing_type="CONSOLIDATED",
        total_quoted_price=payload.totalQuotedPrice,
        payment_terms=payload.paymentTerms,
        advance_payment_percentage=payload.advancePercentage or 0,
        vendor_remarks=payload.remarks,
        status="SUBMITTED",
    )
    db.add(new_resp)
    await db.flush()

    new_veh = LogisticsRfqResponseVehicle(
        response_id=new_resp.id,
        vehicle_number=payload.registrationNo,
        vehicle_registration_no=payload.registrationNo,
        vehicle_type=payload.vehicleType or rfq.vehicle_type_required or "Truck",
        vehicle_capacity_kg=payload.capacityKg,
        vehicle_capacity_cft=payload.capacityCft,
        driver_name=payload.driverName,
        driver_mobile=payload.driverMobile,
        driver_license_no=payload.driverLicense,
        driver_license_expiry=date.today() + timedelta(days=365),
        availability_from=datetime.now(timezone.utc),
        vehicle_base_price=payload.totalQuotedPrice,
        vehicle_loading_charges=0,
        vehicle_unloading_charges=0,
        detention_charges_per_hour=0,
        other_charges=0,
        total_vehicle_price=payload.totalQuotedPrice,
        insurance_required=rfq.insurance_required,
        insurance_cost=float(payload.totalQuotedPrice) * 0.005,
        gps_enabled=payload.gpsEnabled,
    )
    db.add(new_veh)
    await db.flush()

    # Auto-distribute to all SDOs in the RFQ equally
    mappings = rfq.mappings or []
    n = max(len(mappings), 1)
    per_sdo_price = float(payload.totalQuotedPrice) / n
    for m in mappings:
        db.add(LogisticsRfqResponseSdoAssignment(
            response_id=new_resp.id,
            vehicle_response_id=new_veh.id,
            sdo_id=m.sdo_id,
            sdo_quoted_price=per_sdo_price,
            estimated_pickup_datetime=m.required_pickup_datetime,
            estimated_delivery_datetime=m.required_delivery_datetime,
            proposed_route="Standard Transit Mapping",
            estimated_distance_km=150.0,
            estimated_duration_hours=4.0,
        ))

    # Mark invite as quoted
    invite.response_status = "QUOTED"
    db.add(invite)

    # Compute eval score
    res_v = await db.execute(select(Vendor).where(Vendor.id == vendor_id))
    vendor = res_v.scalar_one_or_none()
    v_rating = float(vendor.rating or 4.0) if vendor else 4.0
    criteria = rfq.evaluation_criteria or {"price_weight": 40, "rating_weight": 30, "timeline_weight": 30}
    score = (v_rating / 5.0) * criteria.get("rating_weight", 30)
    price_score = (3500.0 / float(payload.totalQuotedPrice or 5000.0)) * criteria.get("price_weight", 40)
    score += min(price_score, criteria.get("price_weight", 40))
    score += criteria.get("timeline_weight", 30) * 0.9
    new_resp.evaluation_score = min(score, 100.0)
    db.add(new_resp)

    db.add(ActivityLog(
        user_id=None,
        module="logistics",
        action="carrier_submit_quote",
        entity_type="rfq_response",
        entity_id=new_resp.id,
        description=f"Carrier user {current_carrier.username} submitted quote {quote_num} for RFQ {rfq.rfq_number}.",
    ))
    db.add(Notification(
        user_id=rfq.created_by,
        title="New freight bid received",
        message=f"Quote {quote_num} received from {current_carrier.vendor.name if current_carrier.vendor else 'carrier'} for RFQ {rfq.rfq_number}. Score: {new_resp.evaluation_score:.1f}/100.",
        type="success",
        module="logistics",
        reference_type="RFQ",
        reference_id=rfq.id,
    ))
    await db.commit()
    return {"message": "Quote submitted", "response_id": new_resp.id, "response_number": quote_num}


@router.post("/rfqs/{rfq_id}/decline")
async def carrier_decline_invite(
    rfq_id: int,
    payload: CarrierDeclineRfq,
    db: AsyncSession = Depends(get_db),
    current_carrier: CarrierUser = Depends(get_current_carrier_user),
):
    vendor_id = current_carrier.vendor_id
    res_iv = await db.execute(
        select(LogisticsRfqVendor).where(
            LogisticsRfqVendor.rfq_id == rfq_id, LogisticsRfqVendor.vendor_id == vendor_id
        )
    )
    invite = res_iv.scalar_one_or_none()
    if not invite:
        raise HTTPException(404, "Invitation not found")

    invite.response_status = "DECLINED"
    invite.declined_at = datetime.now(timezone.utc)
    invite.decline_reason = payload.reason
    db.add(invite)

    res_r = await db.execute(select(LogisticsRfqMaster).where(LogisticsRfqMaster.id == rfq_id))
    rfq = res_r.scalar_one_or_none()

    db.add(Notification(
        user_id=rfq.created_by if rfq else None,
        title="RFQ invite declined",
        message=f"{current_carrier.vendor.name if current_carrier.vendor else 'Carrier'} declined RFQ {rfq.rfq_number if rfq else rfq_id}. Reason: {payload.reason}",
        type="warning",
        module="logistics",
        reference_type="RFQ",
        reference_id=rfq_id,
    ))
    await db.commit()
    return {"success": True, "message": "Invitation declined"}


@router.get("/so")
async def carrier_list_so(
    db: AsyncSession = Depends(get_db),
    current_carrier: CarrierUser = Depends(get_current_carrier_user),
):
    """List Service Orders awarded to this logged-in carrier."""
    vendor_id = current_carrier.vendor_id
    res = await db.execute(
        select(LogisticsServiceOrder)
        .options(
            selectinload(LogisticsServiceOrder.vehicles),
            selectinload(LogisticsServiceOrder.mappings).joinedload(LogisticsServiceOrderSdoMapping.sdo),
        )
        .where(LogisticsServiceOrder.vendor_id == vendor_id)
        .order_by(LogisticsServiceOrder.id.desc())
    )
    sos = res.scalars().unique().all()
    
    output = []
    for so in sos:
        output.append({
            "id": so.id,
            "so_number": so.so_number,
            "total_order_value": float(so.total_order_value),
            "payment_terms": so.payment_terms,
            "advance_payment_percentage": float(so.advance_payment_percentage or 0),
            "advance_payment_amount": float(so.advance_payment_amount or 0),
            "status": so.status.name if hasattr(so.status, "name") else so.status,
            "acknowledged_by_vendor": so.acknowledged_by_vendor,
            "acknowledged_at": so.acknowledged_at,
            "vendor_remarks": so.vendor_remarks,
            "arrival_date": so.arrival_date,
            "expected_delivery_date": so.expected_delivery_date.date().isoformat() if so.expected_delivery_date else None,
            "vehicles": [
                {
                    "id": v.id,
                    "vehicle_type": v.vehicle_type,
                    "vehicle_registration_no": v.vehicle_registration_no,
                    "driver_name": v.driver_name,
                    "driver_mobile": v.driver_mobile,
                    "driver_license_no": v.driver_license_no,
                    "vehicle_order_value": float(v.vehicle_order_value or 0),
                    "vehicle_status": v.vehicle_status.name if hasattr(v.vehicle_status, "name") else v.vehicle_status,
                    "has_issues": v.has_issues,
                    "issue_description": v.issue_description,
                }
                for v in so.vehicles
            ],
            "mappings": [
                {
                    "id": m.id,
                    "sdo_number": m.sdo.sdo_number if m.sdo else None,
                    "delivery_sequence": m.delivery_sequence,
                    "status": m.status.name if hasattr(m.status, "name") else m.status,
                    "delivered_at": m.delivered_at,
                    "delivered_to": m.delivered_to,
                    "delivery_remarks": m.delivery_remarks
                }
                for m in so.mappings
            ]
        })
    return output


@router.post("/so/{so_id}/acknowledge")
async def carrier_acknowledge_so(
    so_id: int,
    payload: SoAcknowledge,
    db: AsyncSession = Depends(get_db),
    current_carrier: CarrierUser = Depends(get_current_carrier_user),
):
    """Carrier-side Service Order contract acknowledgement."""
    vendor_id = current_carrier.vendor_id
    res = await db.execute(
        select(LogisticsServiceOrder)
        .where(
            LogisticsServiceOrder.id == so_id,
            LogisticsServiceOrder.vendor_id == vendor_id,
        )
    )
    so = res.scalar_one_or_none()
    if not so:
        raise HTTPException(404, "Service Order not found")

    if so.acknowledged_by_vendor:
        raise HTTPException(400, "Service Order is already acknowledged")

    so.acknowledged_by_vendor = True
    so.acknowledged_at = datetime.now(timezone.utc)
    so.arrival_date = payload.arrival_date
    so.vendor_remarks = payload.remarks
    so.status = "ACKNOWLEDGED"
    
    db.add(so)
    
    # Notify creator / admin
    db.add(Notification(
        user_id=so.created_by,
        title="SO Acknowledged by Carrier",
        message=f"Carrier {current_carrier.vendor.name if current_carrier.vendor else 'Carrier'} acknowledged B2B contract {so.so_number}. Vehicles are scheduled for gating.",
        type="success",
        module="logistics",
        reference_type="SO",
        reference_id=so.id,
    ))
    
    # Log activity
    db.add(ActivityLog(
        user_id=None,
        module="logistics",
        action="carrier_acknowledge_so",
        entity_type="so",
        entity_id=so.id,
        description=f"Carrier user {current_carrier.username} acknowledged contract Service Order {so.so_number}.",
    ))
    
    await db.commit()
    return {"success": True, "message": "Service Order acknowledged successfully"}


@router.post("/so/vehicle/{vehicle_id}/issue")
async def carrier_log_vehicle_issue(
    vehicle_id: int,
    payload: VehicleIssueLog,
    db: AsyncSession = Depends(get_db),
    current_carrier: CarrierUser = Depends(get_current_carrier_user),
):
    # Fetch vehicle
    res = await db.execute(
        select(LogisticsServiceOrderVehicle)
        .where(LogisticsServiceOrderVehicle.id == vehicle_id)
    )
    v = res.scalar_one_or_none()
    if not v:
        raise HTTPException(status_code=404, detail="Vehicle not found")

    # Fetch service order and verify ownership
    res_so = await db.execute(
        select(LogisticsServiceOrder)
        .where(LogisticsServiceOrder.id == v.so_id)
    )
    so = res_so.scalar_one_or_none()
    if not so or so.vendor_id != current_carrier.vendor_id:
        raise HTTPException(
            status_code=403,
            detail="You are not authorized to raise alerts for this vehicle's service order"
        )

    v.has_issues = True
    v.issue_description = payload.issueDescription
    db.add(v)

    # Also log a notification for SCM coordinator
    db.add(Notification(
        user_id=so.created_by,
        title="Carrier Transit Alert",
        message=f"Carrier reported issue for vehicle {v.vehicle_registration_no}: {payload.issueDescription}",
        type="error",
        module="logistics",
        reference_type="SO",
        reference_id=v.so_id
    ))

    await db.commit()
    return {"success": True, "message": "Transit alert reported successfully"}

