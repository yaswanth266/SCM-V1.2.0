import asyncio
import logging
import hmac
import hashlib
import json
import uuid
from datetime import datetime, timezone
import httpx
from sqlalchemy import select
from sqlalchemy.orm import selectinload

from app.config import settings
from app.database import AsyncSessionLocal
from app.models.indent import IndentAcknowledgement, IndentAcknowledgementItem, Indent, IndentItem
from app.models.user import User, UserWarehouse
from app.models.issue import MaterialIssue, MaterialIssueItem
from app.models.warehouse import Warehouse, SerialNumber
from app.models.inventory_master import Item, ItemCategory, UOM
from app.services.asset_service import generate_asset_code

logger = logging.getLogger(__name__)

def calculate_signature(body: bytes, secret: str) -> str:
    """Calculate HMAC-SHA256 signature of the raw request body using shared secret."""
    return hmac.new(
        secret.encode("utf-8") if secret else b"",
        body,
        hashlib.sha256
    ).hexdigest()

async def send_webhook_with_retries(payload: dict):
    """Sends webhook payload with retry schedule (immediate, 30s, 2m, 10m)."""
    url = settings.AIMS_WEBHOOK_URL
    secret = settings.AIMS_WEBHOOK_SECRET
    if not url:
        logger.warning("[Webhook Service] AIMS_WEBHOOK_URL is not configured. Webhook skipped.")
        return

    body_bytes = json.dumps(payload).encode("utf-8")
    sig = calculate_signature(body_bytes, secret)

    headers = {
        "Content-Type": "application/json",
        "X-SCM-Signature": sig
    }

    # Delays for retries: 30s, 2m, 10m
    delays = [30, 120, 600]
    
    async with httpx.AsyncClient() as client:
        for attempt in range(len(delays) + 1):
            try:
                logger.info(f"[Webhook Service] Sending event {payload.get('event')} (id: {payload.get('event_id')}), attempt {attempt + 1} to {url}...")
                response = await client.post(url, content=body_bytes, headers=headers, timeout=10.0)
                if 200 <= response.status_code < 300:
                    logger.info(f"[Webhook Service] Successfully sent event {payload.get('event_id')} to AIMS.")
                    return
                logger.warning(f"[Webhook Service] AIMS responded with non-2xx status code {response.status_code} for event {payload.get('event_id')}.")
            except Exception as e:
                logger.error(f"[Webhook Service] Connection error to AIMS for event {payload.get('event_id')}: {e}")

            if attempt < len(delays):
                delay = delays[attempt]
                logger.info(f"[Webhook Service] Retrying event {payload.get('event_id')} in {delay} seconds...")
                await asyncio.sleep(delay)
        
        logger.error(f"[Webhook Service] Failed to send event {payload.get('event_id')} to AIMS after {len(delays) + 1} attempts.")

async def trigger_acknowledgement_webhook(ack_id: int):
    """Queries DB using a new session, constructs a self-contained payload, and schedules delivery."""
    async with AsyncSessionLocal() as db:
        # 1. Wait for acknowledgement to be committed and visible
        ack = None
        for _ in range(10):
            ack_result = await db.execute(select(IndentAcknowledgement).where(IndentAcknowledgement.id == ack_id))
            ack = ack_result.scalar_one_or_none()
            if ack is not None:
                break
            await asyncio.sleep(0.5)

        if not ack:
            logger.error(f"[Webhook Service] IndentAcknowledgement {ack_id} not found/committed. Webhook delivery aborted.")
            return

        # 2. Fetch acknowledger user details
        user_result = await db.execute(
            select(User)
            .options(
                selectinload(User.employee).selectinload(User.employee.property.mapper.class_.position)
            )
            .where(User.id == ack.acknowledged_by)
        )
        received_by_user = user_result.scalar_one_or_none()

        received_by = {
            "employee_code": ack.employee_code or (received_by_user.employee_code if received_by_user else None),
            "user_id": ack.acknowledged_by,
            "name": f"{received_by_user.first_name} {received_by_user.last_name or ''}".strip() if received_by_user else "Unknown User",
            "position": received_by_user.employee.position.name if (received_by_user and received_by_user.employee and received_by_user.employee.position) else (received_by_user.designation if received_by_user else None),
            "email": received_by_user.email if received_by_user else None
        }

        # 3. Fetch parent indent and project
        indent_result = await db.execute(
            select(Indent)
            .options(selectinload(Indent.project))
            .where(Indent.id == ack.indent_id)
        )
        indent = indent_result.scalar_one_or_none()
        if not indent:
            logger.error(f"[Webhook Service] Parent Indent for acknowledgement {ack_id} not found. Webhook delivery aborted.")
            return

        indent_payload = {
            "id": indent.id,
            "number": indent.indent_number,
            "department": indent.department,
            "project_code": indent.project.code if indent.project else None
        }

        # 4. Fetch Material Issue (if any)
        mi_result = await db.execute(
            select(MaterialIssue)
            .where(MaterialIssue.indent_id == indent.id)
            .order_by(MaterialIssue.id.desc())
            .limit(1)
        )
        mi = mi_result.scalar_one_or_none()

        from_payload = {
            "issued_by": None,
            "source_warehouse": None,
            "issue_number": None,
            "issue_date": None,
            "service_code": indent.service_code,
            "vehicle_number": indent.vehicle_number
        }

        if mi:
            # Resolve issuer details
            issuer_res = await db.execute(select(User).where(User.id == mi.issued_by))
            issuer = issuer_res.scalar_one_or_none()
            if issuer:
                from_payload["issued_by"] = {
                    "user_id": issuer.id,
                    "name": f"{issuer.first_name} {issuer.last_name or ''}".strip(),
                    "email": issuer.email
                }

            # Resolve source warehouse details
            src_wh_res = await db.execute(select(Warehouse).where(Warehouse.id == mi.warehouse_id))
            src_wh = src_wh_res.scalar_one_or_none()
            if src_wh:
                from_payload["source_warehouse"] = {
                    "id": src_wh.id,
                    "name": src_wh.name
                }

            from_payload["issue_number"] = mi.issue_number
            from_payload["issue_date"] = mi.issue_date.strftime("%Y-%m-%d") if mi.issue_date else None
            if mi.service_code:
                from_payload["service_code"] = mi.service_code
            if mi.vehicle_number:
                from_payload["vehicle_number"] = mi.vehicle_number

        # 5. Resolve destination warehouse details
        dest_wh_res = await db.execute(select(Warehouse).where(Warehouse.id == indent.warehouse_id))
        dest_wh = dest_wh_res.scalar_one_or_none()

        warehouse_info = None
        if dest_wh:
            warehouse_info = {
                "id": dest_wh.id,
                "name": dest_wh.name,
                "office_id": dest_wh.office_id
            }

        # Resolve destination warehouse custodian
        custodian = None
        if dest_wh:
            uw_result = await db.execute(
                select(UserWarehouse)
                .where(UserWarehouse.warehouse_id == dest_wh.id)
                .limit(1)
            )
            uw = uw_result.scalar_one_or_none()
            if uw:
                cust_res = await db.execute(
                    select(User)
                    .options(selectinload(User.employee).selectinload(User.employee.property.mapper.class_.position))
                    .where(User.id == uw.user_id)
                )
                cust_user = cust_res.scalar_one_or_none()
                if cust_user:
                    custodian = {
                        "employee_code": cust_user.employee_code or (cust_user.employee.employee_code if cust_user.employee else None),
                        "name": f"{cust_user.first_name} {cust_user.last_name or ''}".strip(),
                        "position": cust_user.employee.position.name if (cust_user.employee and cust_user.employee.position) else (cust_user.designation or "Custodian")
                    }

        # Fallback to acknowledger if no custodian is mapped to warehouse
        if not custodian:
            custodian = {
                "employee_code": received_by["employee_code"],
                "name": received_by["name"],
                "position": received_by["position"]
            }

        to_payload = {
            "warehouse": warehouse_info,
            "custodian": custodian,
            "ownership_department": indent.department
        }

        # 6. Resolve Items and Serials
        ack_items_res = await db.execute(
            select(IndentAcknowledgementItem)
            .options(selectinload(IndentAcknowledgementItem.item), selectinload(IndentAcknowledgementItem.indent_item))
            .where(IndentAcknowledgementItem.acknowledgement_id == ack.id)
        )
        ack_items = ack_items_res.scalars().all()

        items_payload = []
        for ai in ack_items:
            if not ai.item:
                continue

            # Fetch category
            cat_res = await db.execute(select(ItemCategory).where(ItemCategory.id == ai.item.category_id))
            cat = cat_res.scalar_one_or_none()

            # Fetch primary UOM
            uom_res = await db.execute(select(UOM).where(UOM.id == ai.item.primary_uom_id))
            uom = uom_res.scalar_one_or_none()

            # Get unit value / rate from Material Issue if available, otherwise purchase price
            mii = None
            if mi:
                mii_result = await db.execute(
                    select(MaterialIssueItem)
                    .where(MaterialIssueItem.issue_id == mi.id, MaterialIssueItem.item_id == ai.item_id)
                    .limit(1)
                )
                mii = mii_result.scalar_one_or_none()

            unit_value = float(mii.rate) if mii else float(ai.item.purchase_price or 0.0)

            # Process Serials
            serials_list = []
            raw_serials = ai.serial_numbers
            if raw_serials:
                if isinstance(raw_serials, str):
                    try:
                        raw_serials = json.loads(raw_serials)
                    except Exception:
                        raw_serials = [raw_serials]

                if isinstance(raw_serials, list):
                    for sn_str in raw_serials:
                        sn_rec_res = await db.execute(
                            select(SerialNumber)
                            .where(SerialNumber.item_id == ai.item_id, SerialNumber.serial_number == sn_str)
                            .limit(1)
                        )
                        sn_rec = sn_rec_res.scalar_one_or_none()

                        serial_id = sn_rec.id if sn_rec else None
                        status = sn_rec.status if sn_rec else "issued"
                        asset_code = sn_rec.asset_code if sn_rec else None
                        consumable_code = sn_rec.consumable_code if sn_rec else None

                        # Address data quality: generate code if missing
                        if ai.item.item_type == "asset" and not asset_code:
                            asset_code = generate_asset_code(sn_str, ai.item.item_code)
                        elif ai.item.item_type == "consumable" and not consumable_code:
                            consumable_code = generate_asset_code(sn_str, ai.item.item_code)

                        serials_list.append({
                            "serial_id": serial_id,
                            "serial_number": sn_str,
                            "asset_code": asset_code,
                            "consumable_code": consumable_code,
                            "status": status
                        })

            items_payload.append({
                "ack_item_id": ai.id,
                "indent_item_id": ai.indent_item_id,
                "item": {
                    "id": ai.item.id,
                    "code": ai.item.item_code,
                    "name": ai.item.name,
                    "type": ai.item.item_type,
                    "category": cat.name if cat else None,
                    "brand": ai.item.brand,
                    "uom": uom.abbreviation if uom else None,
                    "hsn": ai.item.hsn_code
                },
                "received_qty": float(ai.received_qty or 0.0),
                "unit_value": unit_value,
                "ownership_department": indent.department,
                "serials": serials_list
            })

        # Assemble full webhook payload
        payload = {
            "event": "indent.acknowledged",
            "event_id": str(uuid.uuid4()),
            "occurred_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "acknowledgement": {
                "id": ack.id,
                "acknowledged_at": ack.acknowledged_at.strftime("%Y-%m-%dT%H:%M:%SZ") if ack.acknowledged_at else None,
                "status": ack.status,
                "received_by": received_by
            },
            "indent": indent_payload,
            "from": from_payload,
            "to": to_payload,
            "items": items_payload
        }

        # Schedule async webhook dispatch
        asyncio.create_task(send_webhook_with_retries(payload))

async def trigger_serial_asset_code_assigned_webhook(serial_id: int, asset_code: str):
    """Triggers the serial.asset_code_assigned event webhook."""
    payload = {
        "event": "serial.asset_code_assigned",
        "event_id": str(uuid.uuid4()),
        "occurred_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "serial_id": serial_id,
        "asset_code": asset_code
    }
    # Schedule async webhook dispatch
    asyncio.create_task(send_webhook_with_retries(payload))
