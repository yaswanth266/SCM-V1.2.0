from datetime import datetime, timezone
from decimal import Decimal
from typing import Optional
from pydantic import BaseModel
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select, func, update as sql_update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload
from app.database import get_db
from app.models.user import User, Role
from app.models.stock import StockBalance, StockLedger, VehicleStockBalance
from app.models.transfer import StockTransfer, StockTransferItem
from app.models.audit import StockAudit, StockAuditItem, BinReplenishmentRule
from app.models.master import Item
from app.models.procurement_master import Vendor, VendorItem
from app.schemas.inventory import (
    StockBalanceResponse, StockLedgerResponse,
    TransferCreate, TransferUpdate, TransferResponse,
    AuditCreate, AuditResponse,
    ReplenishmentRuleCreate, ReplenishmentRuleResponse,
)
from app.schemas.indent import VehicleStockBalanceResponse
from app.services.number_series import generate_number
from app.services.stock_service import post_stock_ledger
from app.services.approval_service import submit_for_approval
from app.utils.dependencies import get_current_user, require_any_role, require_permission, require_key
from app.utils.helpers import paginate_params, build_paginated_response, apply_search_filter

router = APIRouter()


# ==================== STOCK BALANCE ====================

@router.get("/balance")
async def get_stock_balances(
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=10000),
    item_id: str = Query(None, description="Single ID or comma-separated IDs (e.g., '1,2,3')"),
    warehouse_id: int = Query(None),
    batch_id: int = Query(None),
    # BUG-INV-133: accept category filter (frontend was sending it but backend
    # silently dropped it).
    category: str = Query(None),
    # BUG-INV-134: accept the batch (string) param too — frontend sends a
    # batch_number string under "batch", not a batch_id integer.
    batch: str = Query(None),
    # BUG-INV-135: show items with zero qty if explicitly requested.
    show_zero_stock: bool = Query(False),
    search: str = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    if not isinstance(page, int):
        page = 1
    if not isinstance(page_size, int):
        page_size = 50
    if not isinstance(warehouse_id, int):
        warehouse_id = None
    if not isinstance(batch_id, int):
        batch_id = None
    if not isinstance(category, str):
        category = None
    if not isinstance(batch, str):
        batch = None
    if not isinstance(item_id, str):
        item_id = None
    if not isinstance(show_zero_stock, bool):
        show_zero_stock = False
    if not isinstance(search, str):
        search = None

    offset, limit = paginate_params(page, page_size)
    from app.models.warehouse import WarehouseBin, WarehouseRack, WarehouseLine, WarehouseLocation
    from sqlalchemy.orm import joinedload
    query = select(StockBalance).options(
        joinedload(StockBalance.item),
        joinedload(StockBalance.warehouse),
        joinedload(StockBalance.batch),
        joinedload(StockBalance.bin).joinedload(WarehouseBin.rack).joinedload(WarehouseRack.line).joinedload(WarehouseLine.location),
    )
    count_query = select(func.count(StockBalance.id))

    from app.utils.dependencies import get_user_warehouse_scope_ids

    scoped_wh = await get_user_warehouse_scope_ids(
        db,
        current_user.id,
        exclude_virtual=True,
    )
    if not scoped_wh:
        return build_paginated_response([], 0, page, page_size)
    if warehouse_id is not None and warehouse_id not in scoped_wh:
        raise HTTPException(status_code=403, detail="Not authorized to view stock for this warehouse")
    query = query.where(StockBalance.warehouse_id.in_(scoped_wh))
    count_query = count_query.where(StockBalance.warehouse_id.in_(scoped_wh))

    # Handle single item_id or comma-separated list (e.g., "335,337,349")
    if item_id:
        try:
            item_ids = [int(x.strip()) for x in str(item_id).split(',') if x.strip()]
            if len(item_ids) == 1:
                query = query.where(StockBalance.item_id == item_ids[0])
                count_query = count_query.where(StockBalance.item_id == item_ids[0])
            elif len(item_ids) > 1:
                query = query.where(StockBalance.item_id.in_(item_ids))
                count_query = count_query.where(StockBalance.item_id.in_(item_ids))
        except ValueError:
            # Invalid item_id format, return empty result
            return build_paginated_response([], 0, page, page_size)
    if warehouse_id:
        query = query.where(StockBalance.warehouse_id == warehouse_id)
        count_query = count_query.where(StockBalance.warehouse_id == warehouse_id)
    if batch_id:
        query = query.where(StockBalance.batch_id == batch_id)
        count_query = count_query.where(StockBalance.batch_id == batch_id)
    # BUG-INV-134: support batch-number string filter (frontend sends "batch")
    if batch:
        from app.models.warehouse import Batch as _Batch
        b_q = select(_Batch.id).where(_Batch.batch_number.ilike(f"%{batch.strip()}%"))
        b_ids = [r[0] for r in (await db.execute(b_q)).all()]
        if b_ids:
            query = query.where(StockBalance.batch_id.in_(b_ids))
            count_query = count_query.where(StockBalance.batch_id.in_(b_ids))
        else:
            # No batches match the filter → return empty
            return build_paginated_response([], 0, page, page_size)
    # BUG-INV-133: filter by item_type when category supplied. The frontend
    # CATEGORY_OPTIONS values map to Item.item_type values (raw_material,
    # consumable, finished_good, etc.) — accept either match.
    if category:
        from app.models.master import Item as _ItemCat
        cat_subq = select(_ItemCat.id).where(
            (_ItemCat.item_type == category)
            | (_ItemCat.category_id == (int(category) if str(category).isdigit() else -1))
        )
        query = query.where(StockBalance.item_id.in_(cat_subq))
        count_query = count_query.where(StockBalance.item_id.in_(cat_subq))

    # Apply search filter matching item code or name (similar to /items)
    if search:
        from app.models.master import Item as _ItemSearch
        from app.utils.helpers import apply_search_filter
        search_subq = select(_ItemSearch.id)
        search_subq = apply_search_filter(search_subq, _ItemSearch, search, ["item_code", "readable_code", "name", "sku", "hsn_code"])
        query = query.where(StockBalance.item_id.in_(search_subq))
        count_query = count_query.where(StockBalance.item_id.in_(search_subq))

    if show_zero_stock:
        query = query.where(
            StockBalance.available_qty == 0,
            StockBalance.reserved_qty == 0,
            StockBalance.transit_qty == 0
        )
        count_query = count_query.where(
            StockBalance.available_qty == 0,
            StockBalance.reserved_qty == 0,
            StockBalance.transit_qty == 0
        )
    else:
        from sqlalchemy import or_
        query = query.where(
            or_(
                StockBalance.available_qty > 0,
                StockBalance.reserved_qty > 0,
                StockBalance.transit_qty > 0
            )
        )
        count_query = count_query.where(
            or_(
                StockBalance.available_qty > 0,
                StockBalance.reserved_qty > 0,
                StockBalance.transit_qty > 0
            )
        )

    result = await db.execute(query)
    balances = result.scalars().all()

    # BUG-INV-122: enrich each row with is_low_stock / is_below_reorder /
    # is_expiring_soon flags so the frontend list view can render warning
    # rows without making an extra round-trip per row. Bulk-load batch
    # expiry dates in one query to avoid N+1.
    from datetime import date as _date, timedelta as _td
    today = _date.today()
    expiring_window = today + _td(days=30)
    batch_ids = [b.batch_id for b in balances if b.batch_id]
    batch_exp_map: dict = {}
    if batch_ids:
        from app.models.warehouse import Batch as _Batch
        b_rows = await db.execute(
            select(_Batch.id, _Batch.expiry_date).where(_Batch.id.in_(set(batch_ids)))
        )
        batch_exp_map = {r.id: r.expiry_date for r in b_rows.all()}

    # Identify central warehouses
    wh_ids = {b.warehouse_id for b in balances}
    central_wh_ids = set()
    if wh_ids:
        from app.models.warehouse import Warehouse as _WHModel, WarehouseConfig
        cfg_res = await db.execute(select(WarehouseConfig).where(WarehouseConfig.warehouse_id.in_(wh_ids)))
        configs = {cfg.warehouse_id: cfg.is_central for cfg in cfg_res.scalars().all()}
        
        wh_res = await db.execute(select(_WHModel).where(_WHModel.id.in_(wh_ids)))
        for w in wh_res.scalars().all():
            is_cen = configs.get(w.id)
            if is_cen is None:
                is_cen = (w.parent_id is None)
            if is_cen:
                central_wh_ids.add(w.id)

    # Gather balances with has_serial = True or item_type in (asset, consumable)
    serial_tracked_keys = []
    for b in balances:
        if b.item and (b.item.has_serial or b.item.item_type in ("asset", "consumable")):
            is_cen = b.warehouse_id in central_wh_ids
            # Non-central warehouses ignore bin and batch constraints
            resolved_bin = b.bin_id if is_cen else None
            resolved_batch = b.batch_id if is_cen else None
            serial_tracked_keys.append((b.item_id, b.warehouse_id, resolved_bin, resolved_batch))
    
    serials_map = {}
    asset_codes_map = {}
    consumable_codes_map = {}
    if serial_tracked_keys:
        from sqlalchemy import and_, or_
        from app.models.warehouse import SerialNumber
        from sqlalchemy.orm import joinedload
        
        # Build composite filter
        conditions = []
        for (item_id, wh_id, bin_id, batch_id) in serial_tracked_keys:
            is_cen = wh_id in central_wh_ids
            cond = and_(
                SerialNumber.item_id == item_id,
                SerialNumber.warehouse_id == wh_id,
                SerialNumber.status == "available"
            )
            if is_cen:
                cond = and_(
                    cond,
                    SerialNumber.bin_id == bin_id if bin_id is not None else SerialNumber.bin_id.is_(None),
                    SerialNumber.batch_id == batch_id if batch_id is not None else SerialNumber.batch_id.is_(None)
                )
            conditions.append(cond)
            
        s_query = select(SerialNumber).options(joinedload(SerialNumber.item)).where(or_(*conditions))
        s_result = await db.execute(s_query)
        serials = s_result.scalars().all()
        
        for s in serials:
            is_cen = s.warehouse_id in central_wh_ids
            key = (s.item_id, s.warehouse_id, s.bin_id if is_cen else None, s.batch_id if is_cen else None)
            if key not in serials_map:
                serials_map[key] = []
            if key not in asset_codes_map:
                asset_codes_map[key] = []
            if key not in consumable_codes_map:
                consumable_codes_map[key] = []
                
            raw_serial = s.serial_number
            act_asset_code = s.asset_code
            act_consumable_code = s.consumable_code
            
            # Auto-generate dynamic codes if missing from database
            if not act_asset_code and not act_consumable_code and s.item:
                item_code = s.item.item_code
                prefix = "1-"
                suffix = f"-{item_code}"
                new_prefix = f"{item_code}-1-"
                if raw_serial.startswith(prefix) and raw_serial.endswith(suffix):
                    if s.item.item_type == "asset":
                        act_asset_code = raw_serial
                    elif s.item.item_type == "consumable":
                        act_consumable_code = raw_serial
                    raw_serial = raw_serial[len(prefix):-len(suffix)]
                elif raw_serial.startswith(new_prefix):
                    if s.item.item_type == "asset":
                        act_asset_code = raw_serial
                    elif s.item.item_type == "consumable":
                        act_consumable_code = raw_serial
                    raw_serial = raw_serial[len(new_prefix):]
                    
            if s.item:
                from app.services.asset_service import generate_asset_code
                if s.item.item_type == "asset" and not act_asset_code:
                    act_asset_code = generate_asset_code(raw_serial, s.item.item_code)
                elif s.item.item_type == "consumable" and not act_consumable_code:
                    act_consumable_code = generate_asset_code(raw_serial, s.item.item_code)
            
            serials_map[key].append(raw_serial)
            if act_asset_code:
                asset_codes_map[key].append(act_asset_code)
            if act_consumable_code:
                consumable_codes_map[key].append(act_consumable_code)

    response_items = []
    for b in balances:
        # BUG-FIX: Manually construct dict to avoid Pydantic ValidationError 
        # caused by 'batch' and 'bin' model relationships colliding with 
        # schema field names.
        is_cen = b.warehouse_id in central_wh_ids
        key = (b.item_id, b.warehouse_id, b.bin_id if is_cen else None, b.batch_id if is_cen else None)
        
        sns = list(serials_map.get(key, []))
        acs = list(asset_codes_map.get(key, []))
        ccs = list(consumable_codes_map.get(key, []))
        
        # If the item is asset or consumable, and the database has NO serials/codes:
        if b.item and b.item.item_type in ("asset", "consumable") and not sns and not acs and not ccs:
            qty_int = int(b.total_qty)
            if qty_int > 0:
                from app.services.asset_service import generate_asset_code
                for i in range(1, qty_int + 1):
                    if i > 1000:  # Protect against massive quantities
                        break
                    v_sn = f"V{i}"
                    v_code = generate_asset_code(v_sn, b.item.item_code)
                    sns.append(v_sn)
                    if b.item.item_type == "asset":
                        acs.append(v_code)
                    else:
                        ccs.append(v_code)

        data = {
            "id": b.id,
            "item_id": b.item_id,
            "warehouse_id": b.warehouse_id,
            "bin_id": b.bin_id,
            "batch_id": b.batch_id,
            "available_qty": b.available_qty,
            "reserved_qty": b.reserved_qty,
            "transit_qty": b.transit_qty,
            "total_qty": b.total_qty,
            "valuation_rate": b.valuation_rate,
            "stock_value": b.stock_value,
            "last_updated": b.last_updated.isoformat() if b.last_updated else None,
            "serial_numbers": sns,
            "asset_codes": acs,
            "consumable_codes": ccs,
        }
        if hasattr(b, 'item') and b.item:
            data["item_name"] = b.item.name
            data["item_code"] = b.item.item_code
            data["item_type"] = b.item.item_type
            data["has_serial"] = bool(b.item.has_serial)
            # Include uom_id + uom_name so Stock Audit and Material Issue
            # forms can pre-fill UOM when auto-loading from stock.
            data["uom_id"] = b.item.primary_uom_id
            reorder_level = float(getattr(b.item, "reorder_level", 0) or 0)
            min_stock = float(getattr(b.item, "min_stock_level", 0) or 0)
            total_q = float(b.total_qty or 0)
            data["is_below_reorder"] = bool(reorder_level > 0 and total_q < reorder_level)
            data["is_low_stock"] = bool(min_stock > 0 and total_q <= min_stock)
        else:
            data["item_name"] = None
            data["item_code"] = None
            data["item_type"] = None
            data["has_serial"] = False
            data["uom_id"] = None
            data["is_below_reorder"] = False
            data["is_low_stock"] = False
        data["warehouse_name"] = b.warehouse.name if b.warehouse else None
        # Include batch details (batch_number, expiry_date)
        if b.batch:
            data["batch_name"] = b.batch.batch_number
            data["batch_number"] = b.batch.batch_number
            data["expiry_date"] = b.batch.expiry_date.isoformat() if b.batch.expiry_date else None
            data["manufacturing_date"] = b.batch.manufacturing_date.isoformat() if b.batch.manufacturing_date else None
        else:
            # BUG-INV-112: if the batch record is missing but batch_id is present,
            # it might be a legacy record where batch_id stored the number, or
            # a data corruption. Return the ID as the number to allow the UI to
            # show something.
            data["batch_name"] = str(b.batch_id) if b.batch_id else None
            data["batch_number"] = data["batch_name"]
            data["expiry_date"] = None
            data["manufacturing_date"] = None

        # Include bin details (bin code, location hierarchy)
        if b.bin:
            data["bin_name"] = b.bin.name or b.bin.code
            data["bin_code"] = b.bin.code
            # Rack info
            if b.bin.rack:
                data["rack"] = b.bin.rack.name or b.bin.rack.code
                data["rack_id"] = b.bin.rack_id
                # Location/Line info
                if b.bin.rack.line and b.bin.rack.line.location:
                    data["location"] = b.bin.rack.line.location.name or b.bin.rack.line.location.code
        else:
            data["bin_name"] = None
            data["bin_code"] = None
            data["rack"] = None
            data["rack_id"] = None
            data["location"] = None
        # Expiring-soon flag: any batch within 30 days of expiry counts.
        exp = batch_exp_map.get(b.batch_id) if b.batch_id else None
        if exp is not None and hasattr(exp, "date"):
            exp = exp.date()
        data["is_expiring_soon"] = bool(exp is not None and today <= exp <= expiring_window)
        response_items.append(data)

    # Grouping all items by (item_id, warehouse_id) and calculating weighted average cost (WAC)
    grouped_items = []
    item_groups = {}  # (item_id, warehouse_id) -> list of dicts

    for item in response_items:
        key = (item["item_id"], item["warehouse_id"])
        if key not in item_groups:
            item_groups[key] = []
        item_groups[key].append(item)

    from decimal import ROUND_HALF_UP
    for (item_id, warehouse_id), group_list in item_groups.items():
        first = group_list[0]
        
        total_avail = sum(item["available_qty"] or Decimal("0") for item in group_list)
        total_reserved = sum(item["reserved_qty"] or Decimal("0") for item in group_list)
        total_transit = sum(item["transit_qty"] or Decimal("0") for item in group_list)
        total_qty = sum(item["total_qty"] or Decimal("0") for item in group_list)
        total_value = sum(item["stock_value"] or Decimal("0") for item in group_list)
        
        if total_qty > Decimal("0"):
            valuation_rate = (total_value / total_qty).quantize(Decimal("0.0001"), rounding=ROUND_HALF_UP)
        else:
            valuation_rate = Decimal("0")
            
        # Unique batches
        batches = []
        for item in group_list:
            if item.get("batch_number"):
                batches.append(item["batch_number"])
        batches = sorted(list(set(batches)))
        batch_name = ", ".join(batches) if batches else None
        
        # Expiry and Mfg dates: earliest non-null
        expiry_dates = []
        mfg_dates = []
        for item in group_list:
            if item.get("expiry_date"):
                expiry_dates.append(item["expiry_date"])
            if item.get("manufacturing_date"):
                mfg_dates.append(item["manufacturing_date"])
        
        earliest_expiry = min(expiry_dates) if expiry_dates else None
        earliest_mfg = min(mfg_dates) if mfg_dates else None
        
        # Bins, Racks, Locations
        bins = []
        racks = []
        locations = []
        for item in group_list:
            if item.get("bin_code"):
                bins.append(item["bin_code"])
            if item.get("rack"):
                racks.append(item["rack"])
            if item.get("location"):
                locations.append(item["location"])
                
        bin_code = ", ".join(sorted(list(set(bins)))) if bins else None
        bin_name = bin_code
        rack = ", ".join(sorted(list(set(racks)))) if racks else None
        location = ", ".join(sorted(list(set(locations)))) if locations else None
            # Merge serial numbers
        all_serials = []
        for item in group_list:
            if item.get("serial_numbers"):
                all_serials.extend(item["serial_numbers"])
        all_serials = sorted(list(set(all_serials)))
        
        # Merge asset codes
        all_asset_codes = []
        for item in group_list:
            if item.get("asset_codes"):
                all_asset_codes.extend(item["asset_codes"])
        all_asset_codes = sorted(list(set(all_asset_codes)))

        # Merge consumable codes
        all_consumable_codes = []
        for item in group_list:
            if item.get("consumable_codes"):
                all_consumable_codes.extend(item["consumable_codes"])
        all_consumable_codes = sorted(list(set(all_consumable_codes)))
        
        # Flags
        is_below_reorder = any(item.get("is_below_reorder", False) for item in group_list)
        is_low_stock = any(item.get("is_low_stock", False) for item in group_list)
        is_expiring_soon = any(item.get("is_expiring_soon", False) for item in group_list)
        
        # Last updated: max ISO string
        last_updated_dates = [item["last_updated"] for item in group_list if item.get("last_updated")]
        last_updated = max(last_updated_dates) if last_updated_dates else None
 
        grouped_item = {
            "id": f"grouped_{item_id}_{warehouse_id}",
            "item_id": item_id,
            "warehouse_id": warehouse_id,
            "bin_id": None,
            "batch_id": None,
            "available_qty": total_avail,
            "reserved_qty": total_reserved,
            "transit_qty": total_transit,
            "total_qty": total_qty,
            "valuation_rate": valuation_rate,
            "stock_value": total_value,
            "last_updated": last_updated,
            "serial_numbers": all_serials,
            "asset_codes": all_asset_codes,
            "consumable_codes": all_consumable_codes,
            "item_name": first.get("item_name"),
            "item_code": first.get("item_code"),
            "item_type": first.get("item_type"),
            "has_serial": first.get("has_serial"),
            "uom_id": first.get("uom_id"),
            "is_below_reorder": is_below_reorder,
            "is_low_stock": is_low_stock,
            "warehouse_name": first.get("warehouse_name"),
            "batch_name": batch_name,
            "batch_number": batch_name,
            "expiry_date": earliest_expiry,
            "manufacturing_date": earliest_mfg,
            "bin_name": bin_name,
            "bin_code": bin_code,
            "rack": rack,
            "rack_id": None,
            "location": location,
            "is_expiring_soon": is_expiring_soon,
        }
        grouped_items.append(grouped_item)

    # Sort merged list to keep stable pagination
    grouped_items.sort(key=lambda x: (x.get("item_code") or "", x.get("warehouse_name") or ""))

    total = len(grouped_items)
    paginated_items = grouped_items[offset:offset + page_size]
    return build_paginated_response(paginated_items, total, page, page_size)


@router.get("/vehicle-stock-balance")
async def get_vehicle_stock_balance(
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=10000),
    search: str = Query(None),
    vehicle_code: str = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """List vehicle stock levels with search and pagination."""
    from app.models.stock import VehicleStockBalance
    from app.models.inventory_master import Item
    from app.models.warehouse import Batch
    offset, limit = paginate_params(page, page_size)
    query = select(VehicleStockBalance).options(
        selectinload(VehicleStockBalance.item).selectinload(Item.primary_uom),
        selectinload(VehicleStockBalance.batch),
    )
    count_query = select(func.count(VehicleStockBalance.id))

    if vehicle_code:
        query = query.where(VehicleStockBalance.vehicle_code == vehicle_code)
        count_query = count_query.where(VehicleStockBalance.vehicle_code == vehicle_code)

    if search:
        query = query.join(Item).where(
            VehicleStockBalance.vehicle_code.ilike(f"%{search}%")
            | VehicleStockBalance.vehicle_number.ilike(f"%{search}%")
            | Item.name.ilike(f"%{search}%")
            | Item.item_code.ilike(f"%{search}%")
        )
        count_query = count_query.join(Item).where(
            VehicleStockBalance.vehicle_code.ilike(f"%{search}%")
            | VehicleStockBalance.vehicle_number.ilike(f"%{search}%")
            | Item.name.ilike(f"%{search}%")
            | Item.item_code.ilike(f"%{search}%")
        )

    total = (await db.execute(count_query)).scalar()
    result = await db.execute(query.offset(offset).limit(limit).order_by(VehicleStockBalance.id.desc()))
    records = result.scalars().all()

    item_ids = [r.item_id for r in records if r.item_id]
    valuation_rates_map = {}
    if item_ids:
        from app.models.stock import StockBalance
        # Get the max valuation_rate for each item_id from StockBalance
        val_res = await db.execute(
            select(StockBalance.item_id, func.max(StockBalance.valuation_rate))
            .where(StockBalance.item_id.in_(item_ids))
            .group_by(StockBalance.item_id)
        )
        for row in val_res.all():
            valuation_rates_map[row[0]] = float(row[1] or 0.0)

    all_v_serials = set()
    for r in records:
        if r.serial_numbers:
            for s in r.serial_numbers:
                if s:
                    all_v_serials.add(str(s))

    sn_obj_map = {}
    if all_v_serials:
        from app.models.warehouse import SerialNumber
        sn_res = await db.execute(
            select(SerialNumber).where(SerialNumber.serial_number.in_(list(all_v_serials)))
        )
        for sn_obj in sn_res.scalars().all():
            sn_obj_map[sn_obj.serial_number] = sn_obj

    data = []
    for r in records:
        val_rate = valuation_rates_map.get(r.item_id)
        if val_rate is None or val_rate == 0.0:
            val_rate = float(r.item.purchase_price or 0.0) if r.item else 0.0

        sns = []
        acs = []
        ccs = []
        if r.serial_numbers:
            from app.services.asset_service import generate_asset_code
            for s in r.serial_numbers:
                raw_sn = str(s)
                sns.append(raw_sn)
                sn_obj = sn_obj_map.get(raw_sn)
                act_ac = sn_obj.asset_code if sn_obj else None
                act_cc = sn_obj.consumable_code if sn_obj else None

                if r.item:
                    if r.item.item_type == "asset" and not act_ac:
                        act_ac = generate_asset_code(raw_sn, r.item.item_code)
                    elif r.item.item_type == "consumable" and not act_cc:
                        act_cc = generate_asset_code(raw_sn, r.item.item_code)

                if act_ac:
                    acs.append(act_ac)
                if act_cc:
                    ccs.append(act_cc)

        # Fallback if item is asset or consumable, and no serials exist
        if r.item and r.item.item_type in ("asset", "consumable") and not sns and not acs and not ccs:
            qty_int = int(r.qty or 0)
            if qty_int > 0:
                from app.services.asset_service import generate_asset_code
                for i in range(1, qty_int + 1):
                    if i > 1000:
                        break
                    v_sn = f"V{i}"
                    v_code = generate_asset_code(v_sn, r.item.item_code)
                    sns.append(v_sn)
                    if r.item.item_type == "asset":
                        acs.append(v_code)
                    else:
                        ccs.append(v_code)

        data.append({
            "id": r.id,
            "vehicle_code": r.vehicle_code,
            "vehicle_number": r.vehicle_number,
            "item_id": r.item_id,
            "item_code": r.item.item_code if r.item else None,
            "item_name": r.item.name if r.item else None,
            "item_type": r.item.item_type if r.item else None,
            "has_serial": bool(r.item.has_serial) if r.item else False,
            "uom_id": r.item.primary_uom_id if r.item else None,
            "uom_name": r.item.primary_uom.name if r.item and r.item.primary_uom else None,
            "batch_id": r.batch_id,
            "batch_number": r.batch.batch_number if r.batch else None,
            "qty": float(r.qty),
            "total_qty": float(r.qty),
            "available_qty": float(r.qty),
            "valuation_rate": val_rate,
            "stock_value": float(r.qty) * val_rate,
            "serial_numbers": sns,
            "asset_codes": acs,
            "consumable_codes": ccs,
            "last_updated": r.last_updated.isoformat() if r.last_updated else None,
        })
    return build_paginated_response(data, total, page, page_size)


@router.get("/vehicle-stock-ledger")
async def get_vehicle_stock_ledger(
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=10000),
    vehicle_code: str = Query(None),
    item_id: int = Query(None),
    date_from: str = Query(None),
    date_to: str = Query(None),
    search: str = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Retrieve vehicle stock ledger entries with filters, search and pagination."""
    from app.models.stock import VehicleStockLedger
    from app.models.master import Item
    from app.models.warehouse import Warehouse
    from app.models.user import User as DBUser
    from app.models.issue import VehicleIssue, MaterialAcknowledgement
    from sqlalchemy import or_, cast, String as SqlString, select, func
    from sqlalchemy.orm import selectinload

    offset, limit = paginate_params(page, page_size)

    query = (
        select(VehicleStockLedger)
        .options(
            selectinload(VehicleStockLedger.item),
            selectinload(VehicleStockLedger.warehouse),
            selectinload(VehicleStockLedger.batch),
        )
        .order_by(
            VehicleStockLedger.posting_date.desc(),
            VehicleStockLedger.id.desc()
        )
    )
    count_query = select(func.count(VehicleStockLedger.id))

    if vehicle_code:
        query = query.where(VehicleStockLedger.vehicle_code == vehicle_code)
        count_query = count_query.where(VehicleStockLedger.vehicle_code == vehicle_code)

    if item_id:
        query = query.where(VehicleStockLedger.item_id == item_id)
        count_query = count_query.where(VehicleStockLedger.item_id == item_id)

    if date_from:
        try:
            from datetime import date as _d
            _ = _d.fromisoformat(date_from[:10])
        except Exception:
            raise HTTPException(status_code=400, detail=f"Invalid date_from: {date_from}")
        query = query.where(VehicleStockLedger.posting_date >= date_from)
        count_query = count_query.where(VehicleStockLedger.posting_date >= date_from)

    if date_to:
        try:
            from datetime import date as _d, timedelta as _td
            d = _d.fromisoformat(date_to[:10])
            next_day = d + _td(days=1)
        except Exception:
            raise HTTPException(status_code=400, detail=f"Invalid date_to: {date_to}")
        query = query.where(VehicleStockLedger.posting_date < next_day.isoformat())
        count_query = count_query.where(VehicleStockLedger.posting_date < next_day.isoformat())

    if search:
        search_term = f"%{search.strip()}%"
        query = query.join(VehicleStockLedger.item).outerjoin(VehicleStockLedger.warehouse).where(
            or_(
                Item.item_code.ilike(search_term),
                Item.name.ilike(search_term),
                Warehouse.name.ilike(search_term),
                VehicleStockLedger.vehicle_code.ilike(search_term),
                VehicleStockLedger.transaction_type.ilike(search_term),
                cast(VehicleStockLedger.reference_id, SqlString).ilike(search_term)
            )
        )
        count_query = count_query.join(VehicleStockLedger.item).outerjoin(VehicleStockLedger.warehouse).where(
            or_(
                Item.item_code.ilike(search_term),
                Item.name.ilike(search_term),
                Warehouse.name.ilike(search_term),
                VehicleStockLedger.vehicle_code.ilike(search_term),
                VehicleStockLedger.transaction_type.ilike(search_term),
                cast(VehicleStockLedger.reference_id, SqlString).ilike(search_term)
            )
        )

    total = (await db.execute(count_query)).scalar()
    result = await db.execute(query.offset(offset).limit(limit))
    entries = result.scalars().all()

    # Collect reference info
    vi_ids = {e.reference_id for e in entries if e.reference_type == "vehicle_issue" and e.reference_id}
    ack_ids = {e.reference_id for e in entries if e.reference_type == "material_acknowledgement" and e.reference_id}
    user_ids = {e.created_by for e in entries if e.created_by}

    vi_map = {}
    if vi_ids:
        vi_rows = await db.execute(select(VehicleIssue.id, VehicleIssue.issue_number).where(VehicleIssue.id.in_(list(vi_ids))))
        for r in vi_rows.mappings().all():
            vi_map[r["id"]] = r["issue_number"]

    ack_map = {}
    if ack_ids:
        ack_rows = await db.execute(select(MaterialAcknowledgement.id, MaterialAcknowledgement.acknowledgement_number).where(MaterialAcknowledgement.id.in_(list(ack_ids))))
        for r in ack_rows.mappings().all():
            ack_map[r["id"]] = r["acknowledgement_number"]

    users_map = {}
    if user_ids:
        u_rows = await db.execute(select(DBUser).where(DBUser.id.in_(list(user_ids))))
        for u in u_rows.scalars().all():
            users_map[u.id] = f"{u.first_name} {u.last_name or ''}".strip() or u.username

    response_items = []
    for e in entries:
        ref_num = None
        if e.reference_type == "vehicle_issue":
            ref_num = vi_map.get(e.reference_id)
        elif e.reference_type == "material_acknowledgement":
            ref_num = ack_map.get(e.reference_id)
        
        response_items.append({
            "id": e.id,
            "vehicle_code": e.vehicle_code,
            "vehicle_number": e.vehicle_number,
            "warehouse_id": e.warehouse_id,
            "warehouse_name": e.warehouse.name if e.warehouse else None,
            "item_id": e.item_id,
            "item_code": e.item.item_code if e.item else None,
            "item_name": e.item.name if e.item else None,
            "batch_id": e.batch_id,
            "batch_number": e.batch.batch_number if e.batch else None,
            "transaction_type": e.transaction_type,
            "reference_type": e.reference_type,
            "reference_id": e.reference_id,
            "reference": ref_num or (str(e.reference_id) if e.reference_id else None),
            "qty_in": float(e.qty_in) if e.qty_in is not None else 0.0,
            "qty_out": float(e.qty_out) if e.qty_out is not None else 0.0,
            "balance_qty": float(e.balance_qty) if e.balance_qty is not None else 0.0,
            "rate": float(e.rate) if e.rate is not None else 0.0,
            "value_in": float(e.value_in) if e.value_in is not None else 0.0,
            "value_out": float(e.value_out) if e.value_out is not None else 0.0,
            "balance_value": float(e.balance_value) if e.balance_value is not None else 0.0,
            "posting_date": e.posting_date.isoformat() if e.posting_date else None,
            "posting_time": e.posting_time.isoformat() if e.posting_time else None,
            "created_by": e.created_by,
            "created_by_name": users_map.get(e.created_by),
            "created_at": e.created_at.isoformat() if e.created_at else None,
        })

    return build_paginated_response(response_items, total, page, page_size)


# ==================== STOCK LEDGER ====================

@router.get("/ledger")
async def get_stock_ledger(
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=10000),
    item_id: int = Query(None),
    warehouse_id: int = Query(None),
    transaction_type: str = Query(None),
    date_from: str = Query(None),
    date_to: str = Query(None),
    search: str = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    if not isinstance(page, int):
        page = 1
    if not isinstance(page_size, int):
        page_size = 50
    if not isinstance(warehouse_id, int):
        warehouse_id = None
    if not isinstance(item_id, int):
        item_id = None
    if not isinstance(transaction_type, str):
        transaction_type = None
    if not isinstance(date_from, str):
        date_from = None
    if not isinstance(date_to, str):
        date_to = None
    if not isinstance(search, str):
        search = None

    offset, limit = paginate_params(page, page_size)
    # BUG-INV-124: pin a deterministic order on (posting_date desc, id desc)
    # as a tuple so that subsequent .where() rebinds keep ordering stable
    # under SQLAlchemy's clause-cloning. With only `id desc` the apparent order
    # could shift when posting_date jumps across page boundaries on a
    # back-dated insert. Always order by posting_date first, then id as the
    # tiebreaker so paging is reproducible.
    from sqlalchemy import case
    query = (
        select(StockLedger)
        .options(
            selectinload(StockLedger.item),
            selectinload(StockLedger.warehouse),
        )
        .order_by(
            StockLedger.posting_date.desc(),
            case(
                (StockLedger.qty_out > 0, 1),
                else_=2
            ).asc(),
            StockLedger.id.desc()
        )
    )
    count_query = select(func.count(StockLedger.id))

    # Warehouse-scope isolation: users see their mapped warehouses plus all
    # descendants. super_admin keeps unrestricted stock visibility.
    from app.utils.dependencies import get_user_warehouse_scope_ids
    scoped_wh = await get_user_warehouse_scope_ids(db, current_user.id)
    if not scoped_wh:
        return build_paginated_response([], 0, page, page_size)
    if warehouse_id is not None and warehouse_id not in scoped_wh:
        raise HTTPException(status_code=403, detail="Not authorized to view this warehouse's ledger")
    query = query.where(StockLedger.warehouse_id.in_(scoped_wh))
    count_query = count_query.where(StockLedger.warehouse_id.in_(scoped_wh))

    if item_id:
        query = query.where(StockLedger.item_id == item_id)
        count_query = count_query.where(StockLedger.item_id == item_id)
    if warehouse_id:
        query = query.where(StockLedger.warehouse_id == warehouse_id)
        count_query = count_query.where(StockLedger.warehouse_id == warehouse_id)
    if transaction_type:
        query = query.where(StockLedger.transaction_type == transaction_type)
        count_query = count_query.where(StockLedger.transaction_type == transaction_type)
    if search:
        from app.models.master import Item as _ItemSearch
        from app.models.warehouse import Warehouse as _WhSearch
        from sqlalchemy import or_, cast, String as SqlString
        search_term = f"%{search.strip()}%"
        query = query.join(StockLedger.item).join(StockLedger.warehouse).where(
            or_(
                _ItemSearch.item_code.ilike(search_term),
                _ItemSearch.name.ilike(search_term),
                _WhSearch.name.ilike(search_term),
                StockLedger.transaction_type.ilike(search_term),
                cast(StockLedger.reference_id, SqlString).ilike(search_term)
            )
        )
        count_query = count_query.join(StockLedger.item).join(StockLedger.warehouse).where(
            or_(
                _ItemSearch.item_code.ilike(search_term),
                _ItemSearch.name.ilike(search_term),
                _WhSearch.name.ilike(search_term),
                StockLedger.transaction_type.ilike(search_term),
                cast(StockLedger.reference_id, SqlString).ilike(search_term)
            )
        )
    if date_from:
        # BUG-INV-120: validate date_from input — bad strings raised 500.
        try:
            from datetime import date as _d
            _ = _d.fromisoformat(date_from[:10])
        except Exception:
            raise HTTPException(status_code=400, detail=f"Invalid date_from: {date_from}")
        query = query.where(StockLedger.posting_date >= date_from)
        count_query = count_query.where(StockLedger.posting_date >= date_from)
    if date_to:
        # BUG-INV-117: posting_date is DateTime — `<= date_to` (a YYYY-MM-DD)
        # compares to midnight, excluding entries posted later that day.
        # Use exclusive < (date_to + 1 day) to capture the full boundary day.
        try:
            from datetime import date as _d, timedelta as _td
            d = _d.fromisoformat(date_to[:10])
            next_day = d + _td(days=1)
        except Exception:
            raise HTTPException(status_code=400, detail=f"Invalid date_to: {date_to}")
        query = query.where(StockLedger.posting_date < next_day.isoformat())
        count_query = count_query.where(StockLedger.posting_date < next_day.isoformat())

    total = (await db.execute(count_query)).scalar()
    result = await db.execute(query.offset(offset).limit(limit))
    entries = result.scalars().all()

    # Bulk lookup metadata for the page
    user_ids = {e.created_by for e in entries if e.created_by}
    mi_ids = {e.reference_id for e in entries if e.reference_type == "material_issue" and e.reference_id}
    do_ids = {e.reference_id for e in entries if e.reference_type == "dispatch_order" and e.reference_id}
    ack_ids = {e.reference_id for e in entries if e.reference_type == "dispatch_acknowledgement" and e.reference_id}
    po_ids = {e.reference_id for e in entries if e.reference_type == "putaway_order" and e.reference_id}

    users_map = {}
    if user_ids:
        u_rows = await db.execute(select(User).where(User.id.in_(list(user_ids))))
        for u in u_rows.scalars().all():
            name = f"{u.first_name} {u.last_name or ''}".strip() or u.username
            users_map[u.id] = name

    # Map dispatch orders to material issues
    do_to_mi = {}
    if do_ids:
        from app.models.dispatch import DispatchOrder
        do_rows = await db.execute(
            select(DispatchOrder.id, DispatchOrder.material_issue_id)
            .where(DispatchOrder.id.in_(list(do_ids)))
        )
        for r in do_rows.mappings().all():
            if r["material_issue_id"]:
                do_to_mi[r["id"]] = r["material_issue_id"]

    # Map dispatch acknowledgements to material issues
    ack_to_mi = {}
    if ack_ids:
        from app.models.dispatch import DispatchDeliveryAcknowledgement, DispatchOrder
        ack_rows = await db.execute(
            select(DispatchDeliveryAcknowledgement.id, DispatchOrder.material_issue_id)
            .join(DispatchOrder, DispatchDeliveryAcknowledgement.dispatch_id == DispatchOrder.id)
            .where(DispatchDeliveryAcknowledgement.id.in_(list(ack_ids)))
        )
        for r in ack_rows.mappings().all():
            if r["material_issue_id"]:
                ack_to_mi[r["id"]] = r["material_issue_id"]

    # Collect all material issue IDs (direct + resolved via dispatch/ack)
    all_mi_ids = set(mi_ids)
    all_mi_ids.update(do_to_mi.values())
    all_mi_ids.update(ack_to_mi.values())

    mi_map = {}
    if all_mi_ids:
        from app.models.issue import MaterialIssue
        m_rows = await db.execute(
            select(MaterialIssue.id, MaterialIssue.issue_number)
            .where(MaterialIssue.id.in_(list(all_mi_ids)))
        )
        for r in m_rows.mappings().all():
            mi_map[r["id"]] = r["issue_number"]

    po_map = {}
    if po_ids:
        from app.models.grn import PutawayOrder
        p_rows = await db.execute(
            select(PutawayOrder.id, PutawayOrder.putaway_number)
            .where(PutawayOrder.id.in_(list(po_ids)))
        )
        for r in p_rows.mappings().all():
            po_map[r["id"]] = r["putaway_number"]

    response_items = []
    for e in entries:
        data = StockLedgerResponse.model_validate(e).model_dump()
        data["item_name"] = e.item.name if hasattr(e, 'item') and e.item else None
        data["item_code"] = e.item.item_code if hasattr(e, 'item') and e.item else None
        data["warehouse_name"] = e.warehouse.name if hasattr(e, 'warehouse') and e.warehouse else None
        
        # Human-readable reference
        if e.reference_type == "material_issue":
            data["reference"] = mi_map.get(e.reference_id)
        elif e.reference_type == "dispatch_order":
            mi_id = do_to_mi.get(e.reference_id)
            data["reference"] = mi_map.get(mi_id) if mi_id else str(e.reference_id)
        elif e.reference_type == "dispatch_acknowledgement":
            mi_id = ack_to_mi.get(e.reference_id)
            data["reference"] = mi_map.get(mi_id) if mi_id else str(e.reference_id)
        elif e.reference_type == "putaway_order":
            data["reference"] = po_map.get(e.reference_id)
        else:
            data["reference"] = str(e.reference_id) if e.reference_id else None
            
        # Human-readable created_by
        data["created_by"] = users_map.get(e.created_by) if e.created_by else None
        
        response_items.append(data)

    return build_paginated_response(response_items, total, page, page_size)


# ==================== STOCK TRANSFER ====================

@router.get("/transfers")
async def list_transfers(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    status: str = Query(None),
    source_warehouse_id: int = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    offset, limit = paginate_params(page, page_size)
    query = select(StockTransfer).options(
        selectinload(StockTransfer.items).selectinload(StockTransferItem.item),
        selectinload(StockTransfer.source_warehouse),
        selectinload(StockTransfer.destination_warehouse),
    )
    count_query = select(func.count(StockTransfer.id))

    if status:
        query = query.where(StockTransfer.status == status)
        count_query = count_query.where(StockTransfer.status == status)
    if source_warehouse_id:
        query = query.where(StockTransfer.source_warehouse_id == source_warehouse_id)
        count_query = count_query.where(StockTransfer.source_warehouse_id == source_warehouse_id)

    total = (await db.execute(count_query)).scalar()
    result = await db.execute(query.offset(offset).limit(limit).order_by(StockTransfer.id.desc()))
    transfers = result.scalars().all()

    response_items = []
    for t in transfers:
        data = TransferResponse.model_validate(t).model_dump()
        data["source_warehouse_name"] = t.source_warehouse.name if t.source_warehouse else None
        data["destination_warehouse_name"] = t.destination_warehouse.name if t.destination_warehouse else None
        if data.get("items"):
            enriched_items = []
            for i, ti in enumerate(t.items):
                item_data = data["items"][i]
                item_data["item_name"] = ti.item.name if hasattr(ti, 'item') and ti.item else None
                item_data["item_code"] = ti.item.item_code if hasattr(ti, 'item') and ti.item else None
                enriched_items.append(item_data)
            data["items"] = enriched_items
        response_items.append(data)

    return build_paginated_response(response_items, total, page, page_size)


@router.get("/transfers/{transfer_id}", response_model=TransferResponse)
async def get_transfer(
    transfer_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    result = await db.execute(
        select(StockTransfer).options(
            selectinload(StockTransfer.items).selectinload(StockTransferItem.item)
        )
        .where(StockTransfer.id == transfer_id)
    )
    t = result.scalar_one_or_none()
    if not t:
        raise HTTPException(status_code=404, detail="Transfer not found")

    data = TransferResponse.model_validate(t).model_dump()
    if data.get("items"):
        enriched_items = []
        for i, ti in enumerate(t.items):
            item_data = data["items"][i]
            item_data["item_name"] = ti.item.name if hasattr(ti, 'item') and ti.item else None
            item_data["item_code"] = ti.item.item_code if hasattr(ti, 'item') and ti.item else None
            enriched_items.append(item_data)
        data["items"] = enriched_items
    return data


@router.post("/transfers", status_code=201)
async def create_transfer(
    payload: TransferCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    # BUG-INV-056: source_warehouse cannot equal destination_warehouse for
    # warehouse_to_warehouse / location_to_location transfers — creating a
    # transfer to itself is meaningless and produces a self-cancel ledger pair.
    # bin_to_bin is the legitimate exception (same warehouse, different bins).
    if (
        payload.source_warehouse_id == payload.destination_warehouse_id
        and getattr(payload, "transfer_type", None) != "bin_to_bin"
    ):
        raise HTTPException(
            status_code=400,
            detail="Source and destination warehouses must be different (except bin_to_bin)",
        )
    # BUG-INV-057: validate stock availability at the source warehouse before
    # accepting the transfer request. Optimized: Batch query for all items.
    item_ids = {it.item_id for it in payload.items if it.item_id}
    balance_map = {}
    if item_ids:
        bal_rows = await db.execute(
            select(StockBalance).where(
                StockBalance.warehouse_id == payload.source_warehouse_id,
                StockBalance.item_id.in_(item_ids)
            )
        )
        for b in bal_rows.scalars().all():
            balance_map[(b.item_id, b.batch_id, b.bin_id)] = b.available_qty

    for it in payload.items or []:
        avail = balance_map.get((it.item_id, it.batch_id, it.source_bin_id), Decimal("0"))
        if (it.qty or Decimal("0")) > avail:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"Insufficient stock at source for item {it.item_id} "
                    f"(batch {it.batch_id}, bin {it.source_bin_id}): "
                    f"available={avail}, requested={it.qty}"
                ),
            )

    transfer_number = await generate_number(db, "warehouse", "stock_transfer")
    transfer = StockTransfer(
        transfer_number=transfer_number,
        source_warehouse_id=payload.source_warehouse_id,
        destination_warehouse_id=payload.destination_warehouse_id,
        transfer_date=payload.transfer_date,
        expected_date=payload.expected_date,
        transfer_type=payload.transfer_type,
        remarks=payload.remarks,
        requested_by=current_user.id,
    )
    db.add(transfer)
    await db.flush()

    for item in payload.items:
        ti = StockTransferItem(
            transfer_id=transfer.id, item_id=item.item_id, batch_id=item.batch_id,
            qty=item.qty, uom_id=item.uom_id, source_bin_id=item.source_bin_id,
            destination_bin_id=item.destination_bin_id,
        )
        db.add(ti)

    await db.flush()
    return {"id": transfer.id, "transfer_number": transfer_number, "message": "Transfer created"}


@router.post("/transfers/{transfer_id}/submit")
async def submit_transfer(
    transfer_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    result = await db.execute(select(StockTransfer).where(StockTransfer.id == transfer_id))
    t = result.scalar_one_or_none()
    if not t:
        raise HTTPException(status_code=404, detail="Transfer not found")
    if t.status != "draft":
        raise HTTPException(status_code=400, detail="Only draft transfers can be submitted")
    t.status = "pending_approval"
    approval = await submit_for_approval(
        db, "inventory", "stock_transfer", t.id, t.transfer_number,
        current_user.id,
    )
    await db.flush()
    return {"success": True, "message": "Transfer submitted for approval", "approval_id": approval.id if approval else None}


@router.post("/transfers/{transfer_id}/approve")
async def approve_transfer(
    transfer_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_key("inventory-stock-transfer")),
):
    result = await db.execute(
        select(StockTransfer).options(selectinload(StockTransfer.items))
        .where(StockTransfer.id == transfer_id)
    )
    t = result.scalar_one_or_none()
    if not t:
        raise HTTPException(status_code=404, detail="Transfer not found")
    if t.status != "pending_approval":
        raise HTTPException(status_code=400, detail=f"Cannot approve transfer in '{t.status}' status. Must be 'pending_approval'.")

    # BUG-INV-063: re-verify stock at source between submit & approve.
    # Optimized: Batch query for all items.
    item_ids = {it.item_id for it in t.items if it.item_id}
    balance_map = {}
    if item_ids:
        bal_rows = await db.execute(
            select(StockBalance).where(
                StockBalance.warehouse_id == t.source_warehouse_id,
                StockBalance.item_id.in_(item_ids)
            )
        )
        for b in bal_rows.scalars().all():
            balance_map[(b.item_id, b.batch_id, b.bin_id)] = b.available_qty

    for it in t.items or []:
        avail = balance_map.get((it.item_id, it.batch_id, it.source_bin_id), Decimal("0"))
        if (it.qty or Decimal("0")) > avail:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"Cannot approve — insufficient stock at source for item {it.item_id} "
                    f"(batch {it.batch_id}, bin {it.source_bin_id}): "
                    f"available={avail}, requested={it.qty}. "
                    "Resubmit the transfer with adjusted qty or rebalance source."
                ),
            )

    t.status = "approved"
    t.approved_by = current_user.id
    await db.flush()
    return {"success": True, "message": "Transfer approved"}


@router.post("/transfers/{transfer_id}/dispatch")
async def dispatch_transfer(
    transfer_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_key("inventory-stock-transfer")),
):
    result = await db.execute(
        select(StockTransfer).options(selectinload(StockTransfer.items))
        .where(StockTransfer.id == transfer_id)
    )
    t = result.scalar_one_or_none()
    if not t:
        raise HTTPException(status_code=404, detail="Transfer not found")
    if t.status != "approved":
        raise HTTPException(status_code=400, detail=f"Cannot dispatch transfer in '{t.status}' status. Must be 'approved'.")

    # BUG-INV-058: dispatch must be atomic across ALL lines. Without this,
    # a mid-loop InsufficientStockError leaves the source partially decremented
    # and the transfer status stuck on 'approved' — physical/system mismatch.
    # We use a SAVEPOINT so any failure rolls back every per-line change while
    # keeping the outer request transaction intact for error response.
    async with db.begin_nested():
        # Capture the moving-avg rate at source so we can credit destination
        # at the same valuation (BUG-INV-062 prep — store on the line).
        for item in t.items:
            ledger_row = await post_stock_ledger(
                db, item_id=item.item_id, warehouse_id=t.source_warehouse_id,
                transaction_type="transfer_out", qty_out=item.qty,
                bin_id=item.source_bin_id, batch_id=item.batch_id,
                reference_type="stock_transfer", reference_id=transfer_id,
                uom_id=item.uom_id, created_by=current_user.id,
            )
            item.status = "dispatched"
            # The ledger row's `rate` is the source-side weighted-average. We
            # don't have a dedicated column on StockTransferItem for it, but
            # /receive looks up the most recent transfer_out ledger row for
            # this transfer to read the rate back (BUG-INV-062).
            _ = ledger_row

        t.status = "in_transit"
    await db.flush()
    return {"success": True, "message": "Transfer dispatched"}


@router.post("/transfers/{transfer_id}/receive")
async def receive_transfer(
    transfer_id: int,
    payload: dict | None = None,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_key("inventory-stock-transfer")),
):
    """Receive stock at destination.

    BUG-INV-061: support per-line received_qty in payload so partial receipts
    are possible (truck arrives short, damaged-in-transit, etc.). Body shape
    (optional): {items: [{transfer_item_id, received_qty, destination_bin_id?}]}.
    Falls back to received_qty=qty when not supplied.
    """
    result = await db.execute(
        select(StockTransfer).options(selectinload(StockTransfer.items))
        .where(StockTransfer.id == transfer_id)
    )
    t = result.scalar_one_or_none()
    if not t:
        raise HTTPException(status_code=404, detail="Transfer not found")
    if t.status != "in_transit":
        raise HTTPException(status_code=400, detail=f"Cannot receive transfer in '{t.status}' status. Must be 'in_transit'.")

    # BUG-INV-067: enforce destination warehouse authorisation. The receiver
    # must be assigned to the destination warehouse (super_admin/admin bypass).
    from app.utils.dependencies import (
        get_user_role_codes as _get_role_codes,
        user_warehouse_ids as _user_wh_ids,
    )
    _role_codes = await _get_role_codes(db, current_user.id)
    if not ({"super_admin", "admin"} & set(_role_codes)):
        _wh_ids = await _user_wh_ids(db, current_user.id)
        if t.destination_warehouse_id not in _wh_ids:
            raise HTTPException(
                status_code=403,
                detail="You are not authorised to receive at the destination warehouse",
            )

    # BUG-INV-061: parse per-line received_qty from optional payload
    received_overrides: dict[int, Decimal] = {}
    bin_overrides: dict[int, int] = {}
    if isinstance(payload, dict) and isinstance(payload.get("items"), list):
        for entry in payload["items"]:
            try:
                tid = int(entry.get("transfer_item_id"))
                if "received_qty" in entry and entry["received_qty"] is not None:
                    received_overrides[tid] = Decimal(str(entry["received_qty"]))
                if entry.get("destination_bin_id") is not None:
                    bin_overrides[tid] = int(entry["destination_bin_id"])
            except (TypeError, ValueError):
                continue

    # BUG-INV-062: credit destination at the same rate as the source-side
    # transfer_out ledger row instead of defaulting to 0. Crediting at rate=0
    # diluted the destination warehouse valuation to zero on every transfer.
    for item in t.items:
        # BUG-INV-060: refuse to receive lines that were never dispatched. The
        # transfer-level status check above guards against bypassing dispatch
        # for the whole transfer, but a partial-dispatch flow could leave some
        # lines in 'pending' — they must not be receivable until dispatched.
        if item.status not in ("dispatched", "received"):
            raise HTTPException(
                status_code=400,
                detail=(
                    f"Cannot receive transfer_item {item.id}: line is in "
                    f"'{item.status}' state. Dispatch must complete first."
                ),
            )
        # BUG-INV-061: use override if provided, else default to dispatched qty
        recv_qty = received_overrides.get(item.id, item.qty)
        if recv_qty < 0:
            raise HTTPException(
                status_code=400,
                detail=f"received_qty cannot be negative for transfer_item {item.id}",
            )
        if recv_qty > (item.qty or Decimal("0")):
            raise HTTPException(
                status_code=400,
                detail=(
                    f"received_qty {recv_qty} exceeds dispatched qty {item.qty} "
                    f"for transfer_item {item.id}"
                ),
            )
        # BUG-INV-059: if destination_bin_id is None on the line and a bin override
        # was provided, use it. Otherwise leave None and let stock sit at the
        # warehouse-level balance (caller can assign bin via a follow-up putaway).
        if item.id in bin_overrides:
            item.destination_bin_id = bin_overrides[item.id]
        item.received_qty = recv_qty
        item.status = "received"

        # Look up the matching source-side transfer_out row to recover rate.
        out_row = (await db.execute(
            select(StockLedger.rate)
            .where(
                StockLedger.reference_type == "stock_transfer",
                StockLedger.reference_id == transfer_id,
                StockLedger.transaction_type == "transfer_out",
                StockLedger.item_id == item.item_id,
                StockLedger.batch_id == item.batch_id if item.batch_id is not None else StockLedger.batch_id.is_(None),
            )
            .order_by(StockLedger.id.desc())
            .limit(1)
        )).first()
        recovered_rate = (out_row[0] if out_row and out_row[0] is not None else Decimal("0"))

        # BUG-INV-061: post the actual received qty (may be < dispatched).
        if recv_qty > 0:
            await post_stock_ledger(
                db, item_id=item.item_id, warehouse_id=t.destination_warehouse_id,
                transaction_type="transfer_in", qty_in=recv_qty,
                rate=recovered_rate,
                bin_id=item.destination_bin_id, batch_id=item.batch_id,
                reference_type="stock_transfer", reference_id=transfer_id,
                uom_id=item.uom_id, created_by=current_user.id,
            )

    # BUG-INV-061: if any line was short-received, leave at 'received' so it's
    # visible as not-yet-fully-completed; only flip to 'completed' on full receipt.
    short = any(
        (it.received_qty or Decimal("0")) < (it.qty or Decimal("0"))
        for it in t.items
    )
    t.status = "received" if short else "completed"
    await db.flush()
    return {"success": True, "message": "Transfer received"}


@router.post("/transfers/{transfer_id}/cancel")
async def cancel_transfer(
    transfer_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_key("inventory-stock-transfer")),
):
    """BUG-INV-064: cancel a stock transfer.

    Allowed states:
    - draft / pending_approval / approved → just flip status to cancelled.
    - in_transit → reverse the source-side transfer_out ledger entries (so
      the source gets stock back) and flip the transfer to cancelled. Items
      already received at destination cannot be cancelled — issue a stock
      adjustment instead.
    - received / completed → refuse; create a fresh return-transfer instead.
    """
    result = await db.execute(
        select(StockTransfer).options(selectinload(StockTransfer.items))
        .where(StockTransfer.id == transfer_id)
        .with_for_update()
    )
    t = result.scalar_one_or_none()
    if not t:
        raise HTTPException(status_code=404, detail="Transfer not found")
    if t.status in ("cancelled", "completed", "received"):
        raise HTTPException(
            status_code=400,
            detail=f"Cannot cancel transfer in '{t.status}' status",
        )

    if t.status == "in_transit":
        # Reverse the source-side transfer_out: push qty back IN at the same rate.
        for item in t.items:
            out_row = (await db.execute(
                select(StockLedger.rate)
                .where(
                    StockLedger.reference_type == "stock_transfer",
                    StockLedger.reference_id == transfer_id,
                    StockLedger.transaction_type == "transfer_out",
                    StockLedger.item_id == item.item_id,
                )
                .order_by(StockLedger.id.desc())
                .limit(1)
            )).first()
            recovered_rate = (out_row[0] if out_row and out_row[0] is not None else Decimal("0"))
            await post_stock_ledger(
                db,
                item_id=item.item_id,
                warehouse_id=t.source_warehouse_id,
                transaction_type="transfer_cancel",
                qty_in=item.qty,
                rate=recovered_rate,
                bin_id=item.source_bin_id,
                batch_id=item.batch_id,
                reference_type="stock_transfer_cancel",
                reference_id=transfer_id,
                uom_id=item.uom_id,
                created_by=current_user.id,
            )
            item.status = "pending"

    t.status = "cancelled"
    await db.flush()
    return {"success": True, "message": "Transfer cancelled"}


@router.post("/stock-transfers/{transfer_id}/cancel")
async def cancel_stock_transfer_alias(
    transfer_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_key("inventory-stock-transfer")),
):
    """Alias: POST /inventory/stock-transfers/{id}/cancel."""
    return await cancel_transfer(transfer_id=transfer_id, db=db, current_user=current_user)


# ==================== STOCK AUDIT ====================

@router.get("/audits")
async def list_audits(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    status: str = Query(None),
    warehouse_id: int = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    offset, limit = paginate_params(page, page_size)
    query = select(StockAudit).options(
        selectinload(StockAudit.warehouse),
        selectinload(StockAudit.items).selectinload(StockAuditItem.item),
    )
    count_query = select(func.count(StockAudit.id))

    if status:
        query = query.where(StockAudit.status == status)
        count_query = count_query.where(StockAudit.status == status)
    if warehouse_id:
        query = query.where(StockAudit.warehouse_id == warehouse_id)
        count_query = count_query.where(StockAudit.warehouse_id == warehouse_id)

    total = (await db.execute(count_query)).scalar()
    result = await db.execute(query.offset(offset).limit(limit).order_by(StockAudit.id.desc()))
    audits = result.scalars().all()

    items_list = []
    for a in audits:
        data = AuditResponse.model_validate(a).model_dump()
        data["warehouse_name"] = a.warehouse.name if a.warehouse else None
        # Add item names/codes to audit items
        if a.items and data.get("items"):
            for i, ai in enumerate(a.items):
                if i < len(data["items"]):
                    data["items"][i]["item_name"] = ai.item.name if ai.item else None
                    data["items"][i]["item_code"] = ai.item.item_code if ai.item else None
        items_list.append(data)

    return build_paginated_response(items_list, total, page, page_size)


@router.post("/audits", status_code=201)
async def create_audit(
    payload: AuditCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_key("inventory-stock-audit")),
):
    audit_number = await generate_number(db, "warehouse", "stock_audit")
    variance_count = 0

    audit = StockAudit(
        audit_number=audit_number,
        warehouse_id=payload.warehouse_id,
        audit_date=payload.audit_date,
        audit_type=payload.audit_type,
        total_items=len(payload.items),
        conducted_by=current_user.id,
    )
    db.add(audit)
    await db.flush()

    for item in payload.items:
        variance = item.physical_qty - item.system_qty
        adj_type = "none"
        if variance > 0:
            adj_type = "increase"
            variance_count += 1
        elif variance < 0:
            adj_type = "decrease"
            variance_count += 1

        ai = StockAuditItem(
            audit_id=audit.id, item_id=item.item_id, bin_id=item.bin_id,
            batch_id=item.batch_id, system_qty=item.system_qty,
            physical_qty=item.physical_qty, variance_qty=variance,
            uom_id=item.uom_id, adjustment_type=adj_type, remarks=item.remarks,
        )
        db.add(ai)

    audit.variance_items = variance_count
    await db.flush()
    return {"id": audit.id, "audit_number": audit_number, "message": "Audit created"}


@router.post("/audits/{audit_id}/adjust")
async def adjust_audit(
    audit_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_key("inventory-stock-audit")),
):
    """Apply stock adjustments based on audit findings.

    BUG-INV-080: refuses to re-post if audit already in 'completed' state, so
    the same audit cannot be replayed to double-credit stock.
    BUG-INV-081: caller must hold approver/auditor/admin role — the
    warehouse_manager who created the audit cannot self-approve adjustments
    (separation of duties).
    """
    result = await db.execute(
        select(StockAudit).options(selectinload(StockAudit.items))
        .where(StockAudit.id == audit_id)
    )
    audit = result.scalar_one_or_none()
    if not audit:
        raise HTTPException(status_code=404, detail="Audit not found")

    # BUG-INV-080: idempotency — only allow adjust on draft/pending_approval.
    if audit.status in ("completed", "cancelled", "rejected"):
        raise HTTPException(
            status_code=400,
            detail=f"Cannot adjust audit in '{audit.status}' status — already finalised.",
        )

    # BUG-INV-081: separation of duties — adjuster must not be the same person
    # who conducted the audit (super_admin bypass).
    if audit.conducted_by and audit.conducted_by == current_user.id:
        from app.utils.dependencies import get_user_role_codes as _gurc
        _codes = set(await _gurc(db, current_user.id))
        if "super_admin" not in _codes:
            raise HTTPException(
                status_code=403,
                detail=(
                    "You cannot approve an audit you conducted yourself. A different "
                    "user with approver/auditor/admin role must apply adjustments."
                ),
            )

    for item in audit.items:
        if item.adjustment_type != "none" and not item.adjusted:
            if item.adjustment_type == "increase":
                await post_stock_ledger(
                    db, item_id=item.item_id, warehouse_id=audit.warehouse_id,
                    transaction_type="adjustment", qty_in=abs(item.variance_qty),
                    bin_id=item.bin_id, batch_id=item.batch_id,
                    reference_type="stock_audit", reference_id=audit_id,
                    uom_id=item.uom_id, created_by=current_user.id,
                )
            else:
                await post_stock_ledger(
                    db, item_id=item.item_id, warehouse_id=audit.warehouse_id,
                    transaction_type="adjustment", qty_out=abs(item.variance_qty),
                    bin_id=item.bin_id, batch_id=item.batch_id,
                    reference_type="stock_audit", reference_id=audit_id,
                    uom_id=item.uom_id, created_by=current_user.id,
                )
            item.adjusted = True

    audit.status = "completed"
    audit.approved_by = current_user.id
    await db.flush()
    return {"success": True, "message": "Audit adjustments applied"}


# ==================== REPLENISHMENT RULES ====================

@router.get("/replenishment-rules")
async def list_replenishment_rules(
    item_id: int = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    query = select(BinReplenishmentRule).where(BinReplenishmentRule.is_active == True)
    if item_id:
        query = query.where(BinReplenishmentRule.item_id == item_id)
    result = await db.execute(query)
    rules = result.scalars().all()
    return [ReplenishmentRuleResponse.model_validate(r) for r in rules]


@router.post("/replenishment-rules", status_code=201)
async def create_replenishment_rule(
    payload: ReplenishmentRuleCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    rule = BinReplenishmentRule(**payload.model_dump())
    db.add(rule)
    await db.flush()
    return {"id": rule.id, "message": "Replenishment rule created"}


# ==================== MANUAL STOCK ENTRY ====================

class StockEntryItem(BaseModel):
    item_id: int
    warehouse_id: int
    qty: Decimal
    rate: Decimal = Decimal("0")
    uom_id: Optional[int] = None
    bin_id: Optional[int] = None
    batch_id: Optional[int] = None
    remarks: Optional[str] = None

class StockEntryCreate(BaseModel):
    entry_type: str = "opening"  # opening, adjustment_in, adjustment_out
    remarks: Optional[str] = None
    items: list[StockEntryItem]

from pydantic import BaseModel as BaseModel2

@router.post("/stock-entry", status_code=201)
async def manual_stock_entry(
    payload: StockEntryCreate,
    db: AsyncSession = Depends(get_db),
    # 2026-05-09 — manual stock entry is locked down to super_admin only
    # (data-fix bypass). The product flow forces all stock inbound through
    # GRN → QI → Putaway so batch/expiry/vendor traceability is preserved.
    current_user: User = Depends(require_any_role("super_admin")),
):
    """Manually add/adjust stock — opening stock, manual adjustments.

    BUG-INV-036: opening-balance entries must be one-shot per
    (item, warehouse, bin, batch). If a balance row already exists with any
    posted ledger entry, refuse a second 'opening' to prevent operators from
    silently double-counting starting stock.

    BUG-INV-038: rate=0 on opening or adjustment_in is rejected — without a
    cost figure the weighted-avg valuation gets diluted to zero on subsequent
    inbound moves. (adjustment_out is allowed at rate=0 since it doesn't
    affect valuation_rate calculation.)
    """
    from app.models.stock import StockLedger as _SL
    from app.models.warehouse import Batch as _Batch
    results = []
    for item in payload.items:
        tx_type = payload.entry_type or "opening"

        # BUG-INV-038: enforce non-zero rate on inbound posts
        if tx_type in ("opening", "adjustment_in"):
            if item.rate is None or Decimal(str(item.rate)) <= 0:
                raise HTTPException(
                    status_code=400,
                    detail=(
                        f"rate > 0 is required for '{tx_type}' entries — a zero "
                        f"rate would corrupt weighted-average valuation."
                    ),
                )

        # BUG-INV-037: validate batch_id belongs to item_id. Without this,
        # a UI form bug or a typo'd batch_id can silently link a different
        # item's batch to this stock entry, contaminating the audit trail.
        if item.batch_id is not None:
            b_row = await db.execute(
                select(_Batch).where(_Batch.id == item.batch_id)
            )
            b_obj = b_row.scalar_one_or_none()
            if b_obj is None:
                raise HTTPException(
                    status_code=400,
                    detail=f"Batch {item.batch_id} not found",
                )
            if b_obj.item_id != item.item_id:
                raise HTTPException(
                    status_code=400,
                    detail=(
                        f"Batch {item.batch_id} (#{b_obj.batch_number}) belongs "
                        f"to item {b_obj.item_id}, not {item.item_id}"
                    ),
                )

        # BUG-INV-036: opening-balance lock — refuse a second 'opening' if any
        # ledger entry already exists for this (item, warehouse, bin, batch).
        if tx_type == "opening":
            conds = [
                _SL.item_id == item.item_id,
                _SL.warehouse_id == item.warehouse_id,
            ]
            if item.bin_id is not None:
                conds.append(_SL.bin_id == item.bin_id)
            else:
                conds.append(_SL.bin_id.is_(None))
            if item.batch_id is not None:
                conds.append(_SL.batch_id == item.batch_id)
            else:
                conds.append(_SL.batch_id.is_(None))
            existing_ledger = (await db.execute(
                select(func.count(_SL.id)).where(*conds)
            )).scalar() or 0
            if existing_ledger > 0:
                raise HTTPException(
                    status_code=400,
                    detail=(
                        f"Cannot post 'opening' — ledger already has {existing_ledger} "
                        f"entries for item {item.item_id} at warehouse {item.warehouse_id}. "
                        "Use 'adjustment_in' or 'adjustment_out' instead."
                    ),
                )

        if tx_type in ("opening", "adjustment_in"):
            qty_in = item.qty
            qty_out = Decimal("0")
        else:
            qty_in = Decimal("0")
            qty_out = item.qty

        ledger = await post_stock_ledger(
            db, item_id=item.item_id, warehouse_id=item.warehouse_id,
            transaction_type=tx_type, qty_in=qty_in, qty_out=qty_out,
            rate=item.rate, bin_id=item.bin_id, batch_id=item.batch_id,
            reference_type="manual_entry", uom_id=item.uom_id,
            created_by=current_user.id,
        )
        results.append({"item_id": item.item_id, "ledger_id": ledger.id, "balance_qty": float(ledger.balance_qty)})

    await db.flush()
    return {"success": True, "message": f"{len(results)} stock entries posted", "entries": results}


# ==================== ALIASES (frontend compatibility) ====================

@router.get("/stock-balance")
async def get_stock_balance_alias(
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=10000),
    item_id: str = Query(None),
    warehouse_id: int = Query(None),
    batch_id: int = Query(None),
    category: str = Query(None),
    batch: str = Query(None),
    show_zero_stock: bool = Query(False),
    search: str = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Alias: GET /inventory/stock-balance -> delegates to /inventory/balance."""
    return await get_stock_balances(
        page=page, page_size=page_size, item_id=item_id,
        warehouse_id=warehouse_id, batch_id=batch_id,
        category=category, batch=batch, show_zero_stock=show_zero_stock,
        search=search,
        db=db, current_user=current_user,
    )


@router.get("/stock-ledger")
async def get_stock_ledger_alias(
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=10000),
    item_id: int = Query(None),
    warehouse_id: int = Query(None),
    transaction_type: str = Query(None),
    date_from: str = Query(None),
    date_to: str = Query(None),
    search: str = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Alias: GET /inventory/stock-ledger -> delegates to /inventory/ledger."""
    return await get_stock_ledger(page=page, page_size=page_size, item_id=item_id, warehouse_id=warehouse_id, transaction_type=transaction_type, date_from=date_from, date_to=date_to, search=search, db=db, current_user=current_user)


@router.get("/stock-transfers")
async def list_stock_transfers_alias(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    status: str = Query(None),
    source_warehouse_id: int = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Alias: GET /inventory/stock-transfers -> delegates to /inventory/transfers."""
    return await list_transfers(page=page, page_size=page_size, status=status, source_warehouse_id=source_warehouse_id, db=db, current_user=current_user)


@router.post("/stock-transfers", status_code=201)
async def create_stock_transfer_alias(
    payload: TransferCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Alias: POST /inventory/stock-transfers -> delegates to /inventory/transfers."""
    return await create_transfer(payload=payload, db=db, current_user=current_user)


@router.get("/stock-transfers/{transfer_id}")
async def get_stock_transfer_alias(
    transfer_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Alias: GET /inventory/stock-transfers/{id}."""
    return await get_transfer(transfer_id=transfer_id, db=db, current_user=current_user)


@router.post("/stock-transfers/{transfer_id}/submit")
async def submit_stock_transfer_alias(
    transfer_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Alias: POST /inventory/stock-transfers/{id}/submit."""
    return await submit_transfer(transfer_id=transfer_id, db=db, current_user=current_user)


@router.post("/stock-transfers/{transfer_id}/approve")
async def approve_stock_transfer_alias(
    transfer_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_key("inventory-stock-transfer")),
):
    """B1 fix: alias now enforces same role check as canonical route."""
    return await approve_transfer(transfer_id=transfer_id, db=db, current_user=current_user)


@router.post("/stock-transfers/{transfer_id}/dispatch")
async def dispatch_stock_transfer_alias(
    transfer_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_key("inventory-stock-transfer")),
):
    """B1 fix: alias now enforces same role check as canonical route."""
    return await dispatch_transfer(transfer_id=transfer_id, db=db, current_user=current_user)


@router.post("/stock-transfers/{transfer_id}/receive")
async def receive_stock_transfer_alias(
    transfer_id: int,
    payload: dict | None = None,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_key("inventory-stock-transfer")),
):
    """B1 fix: alias now enforces same role check as canonical route."""
    return await receive_transfer(transfer_id=transfer_id, payload=payload, db=db, current_user=current_user)


@router.get("/stock-audits")
async def list_stock_audits_alias(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    status: str = Query(None),
    warehouse_id: int = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Alias: GET /inventory/stock-audits -> delegates to /inventory/audits."""
    return await list_audits(page=page, page_size=page_size, status=status, warehouse_id=warehouse_id, db=db, current_user=current_user)


@router.post("/stock-audits", status_code=201)
async def create_stock_audit_alias(
    payload: AuditCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_key("inventory-stock-audit")),
):
    """Alias: POST /inventory/stock-audits -> delegates to /inventory/audits."""
    return await create_audit(payload=payload, db=db, current_user=current_user)


@router.put("/stock-audits/{audit_id}/complete")
async def complete_stock_audit(
    audit_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Mark a stock audit as completed."""
    result = await db.execute(select(StockAudit).where(StockAudit.id == audit_id))
    audit = result.scalar_one_or_none()
    if not audit:
        raise HTTPException(status_code=404, detail="Audit not found")
    audit.status = "completed"
    await db.flush()
    return {"success": True, "message": "Audit completed"}


@router.delete("/stock-audits/{audit_id}")
async def delete_stock_audit(
    audit_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Delete a draft stock audit."""
    result = await db.execute(select(StockAudit).where(StockAudit.id == audit_id))
    audit = result.scalar_one_or_none()
    if not audit:
        raise HTTPException(status_code=404, detail="Audit not found")
    if audit.status not in ("draft", None):
        raise HTTPException(status_code=400, detail="Only draft audits can be deleted")
    await db.delete(audit)
    await db.flush()
    return {"success": True, "message": "Audit deleted"}


@router.post("/replenishment/trigger")
async def trigger_replenishment(
    warehouse_id: int = Query(...),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Check replenishment rules and create actual bin-to-bin StockTransfer
    records for items below min_qty.

    BUG-INV-112: previously this only returned a JSON list — no actual
    transfer/movement was created so the warehouse never refilled. Now it
    creates a draft StockTransfer per triggered rule (status=draft) so the
    warehouse manager can review/approve via the regular transfer flow.
    """
    result = await db.execute(
        select(BinReplenishmentRule).where(BinReplenishmentRule.is_active == True)
    )
    rules = result.scalars().all()
    triggered = []

    from datetime import datetime as _dt, date as _date
    for rule in rules:
        # Check current qty in pick bin
        bal_result = await db.execute(
            select(StockBalance).where(
                StockBalance.item_id == rule.item_id,
                StockBalance.bin_id == rule.pick_bin_id,
            )
        )
        balance = bal_result.scalar_one_or_none()
        current_qty = float(balance.available_qty) if balance else 0

        if current_qty >= float(rule.min_qty):
            continue

        # BUG-INV-111: also confirm reserve bin actually has stock to give.
        reserve_bal = (await db.execute(
            select(StockBalance).where(
                StockBalance.item_id == rule.item_id,
                StockBalance.bin_id == rule.reserve_bin_id,
            )
        )).scalar_one_or_none()
        reserve_qty = float(reserve_bal.available_qty) if reserve_bal else 0
        replenish_qty = min(float(rule.replenish_qty), reserve_qty)
        if replenish_qty <= 0:
            triggered.append({
                "item_id": rule.item_id,
                "pick_bin_id": rule.pick_bin_id,
                "reserve_bin_id": rule.reserve_bin_id,
                "current_qty": current_qty,
                "replenish_qty": 0,
                "skipped_reason": "reserve bin empty",
            })
            continue

        # BUG-INV-112: actually create a draft bin-to-bin transfer task.
        try:
            transfer_number = await generate_number(db, "warehouse", "stock_transfer")
        except Exception:
            transfer_number = f"REPL-{warehouse_id}-{rule.id}-{_date.today().isoformat()}"
        transfer = StockTransfer(
            transfer_number=transfer_number,
            source_warehouse_id=warehouse_id,
            destination_warehouse_id=warehouse_id,  # bin-to-bin in same warehouse
            transfer_date=_utcnow(),
            transfer_type="bin_to_bin",
            remarks=f"Auto-replenishment from rule #{rule.id}",
            requested_by=current_user.id,
            status="draft",
        )
        db.add(transfer)
        await db.flush()
        ti = StockTransferItem(
            transfer_id=transfer.id,
            item_id=rule.item_id,
            qty=Decimal(str(replenish_qty)),
            source_bin_id=rule.reserve_bin_id,
            destination_bin_id=rule.pick_bin_id,
        )
        db.add(ti)
        triggered.append({
            "item_id": rule.item_id,
            "pick_bin_id": rule.pick_bin_id,
            "reserve_bin_id": rule.reserve_bin_id,
            "current_qty": current_qty,
            "replenish_qty": replenish_qty,
            "transfer_id": transfer.id,
            "transfer_number": transfer_number,
        })

    await db.flush()
    return {"triggered": triggered, "count": len(triggered)}

# ==================== modularized masters endpoints ====================
from typing import List, Literal, Optional
from datetime import datetime
from pydantic import BaseModel, Field
from sqlalchemy import delete, select, func, or_, text
from sqlalchemy.exc import IntegrityError, OperationalError, SQLAlchemyError
from sqlalchemy.orm import aliased, selectinload
from app.models.master import (
    Item, ItemCategory, UOMCategory, UOM, UOMConversion, ItemUOMConversion,
    Brand, Feature, ItemFeature, ItemAttribute, ItemAttributeValue,
    SpecCategory, Spec, ItemSpec, ItemSpecValue,
    BOM, BOMComponent, RoleItemPermission, ItemType, MasterItemKitComponent,
    PriceList, PriceListItem
)
from app.models.warehouse import Warehouse
from app.schemas.master import (
    ItemCreate, ItemUpdate, ItemResponse,
    CategoryCreate, CategoryResponse,
    UOMCategoryCreate, UOMCategoryResponse, UOMCreate, UOMResponse, UOMConversionCreate, ItemUOMConversionCreate,
    ItemTypeCreate, ItemTypeResponse, FeatureCreate,
    PriceListCreate, PriceListItemCreate, BOMComponentCreate, BOMComponentResponse, BOMCreate, BOMResponse, BOMUpdate,
    UserItemBulkMapCreate
)
from app.utils.schema_sync import (
    ensure_feature_schema, ensure_item_category_code_schema, ensure_uom_enterprise_schema,
    ensure_item_attribute_uom_schema, ensure_specs_schema, ensure_item_uom_category_schema,
    ensure_user_item_permission_schema, ensure_organization_structure_schema
)
import re

PRECISION_TOLERANCE = Decimal("0.000000001")

def _utcnow():
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).replace(tzinfo=None)

def _as_decimal(value):
    return Decimal(str(value))

def _factor_parts(payload):
    factor_den = _as_decimal(payload.factor_den if payload.factor_den is not None else 1)
    if payload.factor_num is not None:
        factor_num = _as_decimal(payload.factor_num)
        factor = factor_num / factor_den
    else:
        factor = _as_decimal(payload.conversion_factor)
        factor_num = factor
    if factor_num <= 0 or factor_den <= 0 or factor <= 0:
        raise HTTPException(status_code=422, detail="Conversion factors must be greater than 0")
    return factor_num, factor_den, factor

def _factors_match(left: Decimal, right: Decimal) -> bool:
    return abs(left - right) <= PRECISION_TOLERANCE

@router.get("/uom-categories")
async def list_uom_categories(
    include_inactive: bool = Query(False),
    search: str = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    await ensure_uom_enterprise_schema(db)
    q = select(UOMCategory).order_by(UOMCategory.name)
    if not include_inactive:
        q = q.where(UOMCategory.is_active == True)  # noqa: E712
    if search:
        like = f"%{search}%"
        q = q.where(UOMCategory.name.ilike(like))
    result = await db.execute(q)
    items = result.scalars().all()
    base_ids = {i.base_uom_id for i in items if i.base_uom_id}
    base_map = {}
    if base_ids:
        rows = (await db.execute(select(UOM).where(UOM.id.in_(base_ids)))).scalars().all()
        base_map = {row.id: row for row in rows}
    return [
        {
            "id": i.id,
            "name": i.name,
            "description": i.description,
            "base_uom_id": i.base_uom_id,
            "base_uom_name": base_map.get(i.base_uom_id).name if i.base_uom_id in base_map else None,
            "base_uom_abbreviation": base_map.get(i.base_uom_id).abbreviation if i.base_uom_id in base_map else None,
            "is_active": i.is_active,
            "status": "active" if i.is_active else "inactive",
        }
        for i in items
    ]


@router.post("/uom-categories", status_code=201)
async def create_uom_category(
    payload: UOMCategoryCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    await ensure_uom_enterprise_schema(db)
    name = payload.name.strip()
    existing = await db.execute(
        select(UOMCategory).where(func.lower(func.trim(UOMCategory.name)) == name.lower())
    )
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=409, detail=f"UOM category '{name}' already exists")
    if payload.base_uom_id:
        base_uom = (
            await db.execute(
                select(UOM).where(
                    UOM.id == payload.base_uom_id,
                    UOM.is_active == True,  # noqa: E712
                )
            )
        ).scalar_one_or_none()
        if not base_uom:
            raise HTTPException(status_code=422, detail="Base UOM does not exist or is inactive")
    category = UOMCategory(
        name=name,
        description=payload.description,
        base_uom_id=payload.base_uom_id,
        is_active=True if payload.is_active is None else bool(payload.is_active),
    )
    db.add(category)
    await db.flush()
    return {"id": category.id, "message": "UOM category created"}


@router.put("/uom-categories/{category_id}")
async def update_uom_category(
    category_id: int,
    payload: UOMCategoryCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    await ensure_uom_enterprise_schema(db)
    category = (await db.execute(select(UOMCategory).where(UOMCategory.id == category_id))).scalar_one_or_none()
    if not category:
        raise HTTPException(status_code=404, detail="UOM category not found")
    name = payload.name.strip()
    dup = await db.execute(
        select(UOMCategory).where(
            func.lower(func.trim(UOMCategory.name)) == name.lower(),
            UOMCategory.id != category_id,
        )
    )
    if dup.scalar_one_or_none():
        raise HTTPException(status_code=409, detail=f"UOM category '{name}' already exists")
    category.name = name
    category.description = payload.description
    if payload.base_uom_id:
        base_uom = (
            await db.execute(
                select(UOM).where(
                    UOM.id == payload.base_uom_id,
                    UOM.is_active == True,  # noqa: E712
                )
            )
        ).scalar_one_or_none()
        if not base_uom:
            raise HTTPException(status_code=422, detail="Base UOM does not exist or is inactive")
        if base_uom.category_id and base_uom.category_id != category.id:
            raise HTTPException(status_code=422, detail="Base UOM must belong to this category")
    category.base_uom_id = payload.base_uom_id
    if payload.is_active is not None:
        category.is_active = bool(payload.is_active)
    await db.flush()
    return {"id": category.id, "message": "UOM category updated"}


@router.delete("/uom-categories/{category_id}")
async def delete_uom_category(
    category_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    await ensure_uom_enterprise_schema(db)
    category = (await db.execute(select(UOMCategory).where(UOMCategory.id == category_id))).scalar_one_or_none()
    if not category:
        raise HTTPException(status_code=404, detail="UOM category not found")
    uom_count = await db.scalar(
        select(func.count(UOM.id)).where(UOM.category_id == category_id, UOM.is_active == True)  # noqa: E712
    )
    attr_count = await db.scalar(
        select(func.count(ItemAttribute.id)).where(ItemAttribute.uom_category_id == category_id)
    )
    value_count = await db.scalar(
        select(func.count(ItemAttributeValue.id)).where(ItemAttributeValue.uom_category_id == category_id)
    )
    in_use = int(uom_count or 0) + int(attr_count or 0) + int(value_count or 0)
    if in_use:
        raise HTTPException(
            status_code=409,
            detail=f"Cannot deactivate category referenced by {in_use} UOM/attribute record(s).",
        )
    category.is_active = False
    await db.flush()
    return {"message": "UOM category deactivated"}


@router.get("/uom")
async def list_uom(
    include_inactive: bool = Query(False),
    category_id: int = Query(None),
    search: str = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    await ensure_uom_enterprise_schema(db)
    # By default return only active UOMs. When include_inactive=True (e.g.
    # admin lookup or label resolution for old docs) return all rows.
    # BUG-FE-086 / BUG-FE-170: previously include_inactive was ignored.
    q = select(UOM).order_by(UOM.name)
    if not include_inactive:
        q = q.where(UOM.is_active == True)  # noqa: E712
    if category_id is not None:
        q = q.where(UOM.category_id == category_id)
    if search:
        like = f"%{search}%"
        q = q.where((UOM.name.ilike(like)) | (UOM.abbreviation.ilike(like)))
    result = await db.execute(q)
    items = result.scalars().all()
    category_ids = {i.category_id for i in items if i.category_id}
    category_map = {}
    if category_ids:
        rows = await db.execute(select(UOMCategory.id, UOMCategory.name).where(UOMCategory.id.in_(category_ids)))
        category_map = {row.id: row.name for row in rows}
    return [
        {
            "id": i.id,
            "category_id": i.category_id,
            "category_name": category_map.get(i.category_id),
            "name": i.name,
            "abbreviation": i.abbreviation,
            "is_active": i.is_active,
            "status": "active" if i.is_active else "inactive",
        }
        for i in items
    ]


@router.post("/uom", status_code=201)
async def create_uom(
    payload: UOMCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    await ensure_uom_enterprise_schema(db)
    # Case-insensitive duplicate check
    existing = await db.execute(
        select(UOM).where(func.lower(UOM.name) == payload.name.lower())
    )
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=409, detail=f"UOM with name '{payload.name}' already exists")
    if payload.category_id:
        category = (
            await db.execute(
                select(UOMCategory).where(
                    UOMCategory.id == payload.category_id,
                    UOMCategory.is_active == True,  # noqa: E712
                )
            )
        ).scalar_one_or_none()
        if not category:
            raise HTTPException(status_code=422, detail="UOM category does not exist or is inactive")
    uom = UOM(name=payload.name, abbreviation=payload.abbreviation, category_id=payload.category_id)
    # BUG-FE-085: persist optional is_active flag from the form
    if payload.is_active is not None:
        uom.is_active = bool(payload.is_active)
    db.add(uom)
    await db.flush()
    return {"id": uom.id, "message": "UOM created"}


async def _uom_in_use(db: AsyncSession, uom_id: int) -> int:
    """Count items / attributes / values referencing this UOM."""
    from app.models.master import Item, ItemAttribute, ItemAttributeValue
    q1 = await db.scalar(
        select(func.count(Item.id)).where(
            (Item.primary_uom_id == uom_id) | (Item.secondary_uom_id == uom_id)
        )
    )
    q2 = await db.scalar(
        select(func.count(ItemAttribute.id)).where(ItemAttribute.uom_id == uom_id)
    )
    q3 = await db.scalar(
        select(func.count(ItemAttributeValue.id)).where(ItemAttributeValue.uom_id == uom_id)
    )
    return int(q1 or 0) + int(q2 or 0) + int(q3 or 0)


@router.put("/uom/{uom_id}")
async def update_uom(
    uom_id: int,
    payload: UOMCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    await ensure_uom_enterprise_schema(db)
    result = await db.execute(select(UOM).where(UOM.id == uom_id))
    uom = result.scalar_one_or_none()
    if not uom:
        raise HTTPException(status_code=404, detail="UOM not found")
    # UOM name/abbreviation are locked once in use, but category tagging is
    # metadata and can be changed without invalidating existing quantities.
    in_use = await _uom_in_use(db, uom_id)
    identity_changed = (
        uom.name.strip().lower() != payload.name.strip().lower()
        or uom.abbreviation.strip().lower() != payload.abbreviation.strip().lower()
    )
    if in_use and identity_changed:
        raise HTTPException(
            status_code=409,
            detail=f"UOM is referenced by {in_use} record(s) and cannot be edited. Create a new UOM instead.",
        )
    if payload.category_id:
        category = (
            await db.execute(
                select(UOMCategory).where(
                    UOMCategory.id == payload.category_id,
                    UOMCategory.is_active == True,  # noqa: E712
                )
            )
        ).scalar_one_or_none()
        if not category:
            raise HTTPException(status_code=422, detail="UOM category does not exist or is inactive")
    uom.category_id = payload.category_id
    uom.name = payload.name
    uom.abbreviation = payload.abbreviation
    # BUG-FE-085: also accept is_active updates from the UI
    if payload.is_active is not None:
        uom.is_active = bool(payload.is_active)
    await db.flush()
    return {"id": uom.id, "message": "UOM updated"}


@router.delete("/uom/{uom_id}")
async def delete_uom(
    uom_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    await ensure_uom_enterprise_schema(db)
    result = await db.execute(select(UOM).where(UOM.id == uom_id))
    uom = result.scalar_one_or_none()
    if not uom:
        raise HTTPException(status_code=404, detail="UOM not found")
    in_use = await _uom_in_use(db, uom_id)
    if in_use:
        raise HTTPException(
            status_code=409,
            detail=f"UOM is referenced by {in_use} record(s) and cannot be deleted.",
        )
    uom.is_active = False
    await db.flush()
    # BUG-FE-084: this is a soft-deactivate, not a hard delete. Return the
    # accurate message so callers don't think the row is gone.
    return {"message": "UOM deactivated"}


@router.get("/uom-conversions")
async def list_uom_conversions(
    include_history: bool = Query(False),
    category_id: int = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    await ensure_uom_enterprise_schema(db)
    as_of = _utcnow()
    q = select(UOMConversion).order_by(UOMConversion.category_id, UOMConversion.from_uom_id, UOMConversion.to_uom_id)
    if not include_history:
        q = q.where(UOMConversion.valid_from <= as_of, or_(UOMConversion.valid_to.is_(None), UOMConversion.valid_to > as_of))
    if category_id is not None:
        q = q.where(UOMConversion.category_id == category_id)
    result = await db.execute(
        q
    )
    conversions = result.scalars().all()
    uom_ids = {c.from_uom_id for c in conversions} | {c.to_uom_id for c in conversions}
    uom_map = {}
    if uom_ids:
        rows = (await db.execute(select(UOM).where(UOM.id.in_(uom_ids)))).scalars().all()
        uom_map = {row.id: row for row in rows}
    items = []
    for conv in conversions:
        from_uom = uom_map.get(conv.from_uom_id)
        to_uom = uom_map.get(conv.to_uom_id)
        items.append({
            "id": conv.id,
            "category_id": conv.category_id,
            "from_uom_id": conv.from_uom_id,
            "to_uom_id": conv.to_uom_id,
            "from_uom": {"id": from_uom.id, "name": from_uom.name, "abbreviation": from_uom.abbreviation} if from_uom else None,
            "to_uom": {"id": to_uom.id, "name": to_uom.name, "abbreviation": to_uom.abbreviation} if to_uom else None,
            "from_uom_name": from_uom.name if from_uom else None,
            "to_uom_name": to_uom.name if to_uom else None,
            "factor_num": str(conv.factor_num),
            "factor_den": str(conv.factor_den),
            "conversion_factor": str(conv.conversion_factor),
            "valid_from": conv.valid_from,
            "valid_to": conv.valid_to,
            "is_system": bool(conv.is_system),
        })
    return items


def _validate_uom_conversion(payload: UOMConversionCreate) -> None:
    # BUG-FE-087: forbid self-conversion (kgâ†’kg = 5.0 used to be accepted).
    if payload.from_uom_id == payload.to_uom_id:
        raise HTTPException(
            status_code=422,
            detail="from_uom and to_uom must be different",
        )
    _factor_parts(payload)


async def _load_uom_pair(db: AsyncSession, from_uom_id: int, to_uom_id: int) -> tuple[UOM, UOM]:
    rows = (await db.execute(select(UOM).where(UOM.id.in_([from_uom_id, to_uom_id])))).scalars().all()
    uoms = {row.id: row for row in rows}
    from_uom = uoms.get(from_uom_id)
    to_uom = uoms.get(to_uom_id)
    if not from_uom or not to_uom:
        raise HTTPException(status_code=422, detail="Both UOMs must exist")
    if not from_uom.is_active or not to_uom.is_active:
        raise HTTPException(status_code=422, detail="Both UOMs must be active")
    return from_uom, to_uom


async def _active_global_conversion(
    db: AsyncSession,
    from_uom_id: int,
    to_uom_id: int,
    as_of: datetime | None = None,
) -> UOMConversion | None:
    as_of = as_of or _utcnow()
    return (
        await db.execute(
            select(UOMConversion).where(
                UOMConversion.from_uom_id == from_uom_id,
                UOMConversion.to_uom_id == to_uom_id,
                UOMConversion.valid_from <= as_of,
                or_(UOMConversion.valid_to.is_(None), UOMConversion.valid_to > as_of),
            )
        )
    ).scalar_one_or_none()


async def _conversion_edges(db: AsyncSession, item_id: int | None, as_of: datetime) -> dict[int, list[tuple[int, Decimal, str]]]:
    edges: dict[int, list[tuple[int, Decimal, str]]] = {}
    global_rows = (
        await db.execute(
            select(UOMConversion).where(
                UOMConversion.valid_from <= as_of,
                or_(UOMConversion.valid_to.is_(None), UOMConversion.valid_to > as_of),
            )
        )
    ).scalars().all()
    for row in global_rows:
        factor = _as_decimal(row.conversion_factor)
        edges.setdefault(row.from_uom_id, []).append((row.to_uom_id, factor, "global"))
        edges.setdefault(row.to_uom_id, []).append((row.from_uom_id, Decimal("1") / factor, "global-reciprocal"))
    if item_id:
        item_rows = (
            await db.execute(
                select(ItemUOMConversion).where(
                    ItemUOMConversion.item_id == item_id,
                    ItemUOMConversion.is_active == True,  # noqa: E712
                    ItemUOMConversion.valid_from <= as_of,
                    or_(ItemUOMConversion.valid_to.is_(None), ItemUOMConversion.valid_to > as_of),
                )
            )
        ).scalars().all()
        for row in item_rows:
            factor = _as_decimal(row.conversion_factor)
            edges.setdefault(row.from_uom_id, []).append((row.to_uom_id, factor, row.conversion_type or "item"))
            edges.setdefault(row.to_uom_id, []).append((row.from_uom_id, Decimal("1") / factor, row.conversion_type or "item-reciprocal"))
    return edges


async def _find_conversion_factor(
    db: AsyncSession,
    from_uom_id: int,
    to_uom_id: int,
    item_id: int | None = None,
    as_of: datetime | None = None,
    ignored_pair: tuple[int, int] | None = None,
) -> tuple[Decimal | None, list[int]]:
    as_of = as_of or _utcnow()
    edges = await _conversion_edges(db, item_id, as_of)
    if ignored_pair:
        a, b = ignored_pair
        edges[a] = [(n, f, s) for n, f, s in edges.get(a, []) if n != b]
        edges[b] = [(n, f, s) for n, f, s in edges.get(b, []) if n != a]
    queue = [(from_uom_id, Decimal("1"), [from_uom_id])]
    visited = {from_uom_id}
    while queue:
        node, factor, path = queue.pop(0)
        if node == to_uom_id:
            return factor, path
        for neighbor, edge_factor, _source in edges.get(node, []):
            if neighbor in visited:
                continue
            visited.add(neighbor)
            queue.append((neighbor, factor * edge_factor, [*path, neighbor]))
    return None, []


async def _validate_global_conversion_business_rules(
    db: AsyncSession,
    payload: UOMConversionCreate,
    exclude_pair: tuple[int, int] | None = None,
) -> tuple[UOM, UOM, int, Decimal, Decimal, Decimal]:
    _validate_uom_conversion(payload)
    factor_num, factor_den, factor = _factor_parts(payload)
    from_uom, to_uom = await _load_uom_pair(db, payload.from_uom_id, payload.to_uom_id)
    if not from_uom.category_id or not to_uom.category_id:
        raise HTTPException(status_code=422, detail="Both UOMs must belong to a UOM category before conversion")
    if from_uom.category_id != to_uom.category_id:
        raise HTTPException(status_code=422, detail="Global UOM conversions cannot cross categories. Use item UOM conversions for density/yield/width bridges.")
    category_id = payload.category_id or from_uom.category_id
    if category_id != from_uom.category_id:
        raise HTTPException(status_code=422, detail="Conversion category must match the selected UOMs")
    implied, path = await _find_conversion_factor(
        db,
        payload.from_uom_id,
        payload.to_uom_id,
        as_of=payload.valid_from or _utcnow(),
        ignored_pair=exclude_pair,
    )
    if implied is not None and not _factors_match(implied, factor):
        raise HTTPException(
            status_code=409,
            detail=f"Math inconsistency. Existing route {path} implies 1 from UOM = {implied} to UOM, but entered {factor}.",
        )
    return from_uom, to_uom, category_id, factor_num, factor_den, factor


@router.post("/uom-conversions", status_code=201)
async def create_uom_conversion(
    payload: UOMConversionCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    await ensure_uom_enterprise_schema(db)
    _from_uom, _to_uom, category_id, factor_num, factor_den, factor = await _validate_global_conversion_business_rules(db, payload)
    existing = await _active_global_conversion(db, payload.from_uom_id, payload.to_uom_id, payload.valid_from)
    if existing:
        raise HTTPException(
            status_code=409,
            detail="Conversion for this UOM pair already exists"
        )
    inverse = await _active_global_conversion(db, payload.to_uom_id, payload.from_uom_id, payload.valid_from)
    if inverse:
        inverse_factor = Decimal("1") / _as_decimal(inverse.conversion_factor)
        if not _factors_match(inverse_factor, factor):
            raise HTTPException(
                status_code=409,
                detail=f"Math inconsistency. Existing inverse implies factor {inverse_factor}, but entered {factor}.",
            )
        return {
            "id": inverse.id,
            "message": "Inverse conversion already exists. Record not duplicated.",
            "notice": "Conversion stored through the reciprocal record.",
        }
    valid_from = payload.valid_from or _utcnow()
    conv = UOMConversion(
        category_id=category_id,
        from_uom_id=payload.from_uom_id,
        to_uom_id=payload.to_uom_id,
        factor_num=factor_num,
        factor_den=factor_den,
        conversion_factor=factor,
        valid_from=valid_from,
        valid_to=payload.valid_to,
        is_system=bool(payload.is_system),
    )
    reciprocal = UOMConversion(
        category_id=category_id,
        from_uom_id=payload.to_uom_id,
        to_uom_id=payload.from_uom_id,
        factor_num=factor_den,
        factor_den=factor_num,
        conversion_factor=Decimal("1") / factor,
        valid_from=valid_from,
        valid_to=payload.valid_to,
        is_system=bool(payload.is_system),
    )
    db.add(conv)
    db.add(reciprocal)
    await db.flush()
    return {"id": conv.id, "reciprocal_id": reciprocal.id, "message": "UOM conversion created"}


@router.put("/uom-conversions/{conv_id}")
async def update_uom_conversion(
    conv_id: int,
    payload: UOMConversionCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    await ensure_uom_enterprise_schema(db)
    _from_uom, _to_uom, category_id, factor_num, factor_den, factor = await _validate_global_conversion_business_rules(
        db,
        payload,
        exclude_pair=(payload.from_uom_id, payload.to_uom_id),
    )
    result = await db.execute(select(UOMConversion).where(UOMConversion.id == conv_id))
    conv = result.scalar_one_or_none()
    if not conv:
        raise HTTPException(status_code=404, detail="UOM conversion not found")

    active_dup = await _active_global_conversion(db, payload.from_uom_id, payload.to_uom_id, payload.valid_from)
    if active_dup and active_dup.id != conv_id:
        raise HTTPException(status_code=409, detail="Another active conversion for this UOM pair already exists")
    now = _utcnow()
    conv.valid_to = now
    db.add(UOMConversion(
        category_id=category_id,
        from_uom_id=payload.from_uom_id,
        to_uom_id=payload.to_uom_id,
        factor_num=factor_num,
        factor_den=factor_den,
        conversion_factor=factor,
        valid_from=payload.valid_from or now,
        valid_to=payload.valid_to,
        is_system=bool(payload.is_system),
    ))
    await db.flush()
    return {"id": conv.id, "message": "UOM conversion superseded with a new effective-dated row"}


@router.delete("/uom-conversions/{conv_id}")
async def delete_uom_conversion(
    conv_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    await ensure_uom_enterprise_schema(db)
    result = await db.execute(select(UOMConversion).where(UOMConversion.id == conv_id))
    conv = result.scalar_one_or_none()
    if not conv:
        raise HTTPException(status_code=404, detail="UOM conversion not found")
    if conv.is_system:
        raise HTTPException(status_code=409, detail="System conversion cannot be deleted")
    conv.valid_to = _utcnow()
    await db.flush()
    return {"message": "UOM conversion expired"}


@router.get("/uom-conversions/convert")
async def convert_uom_quantity(
    from_uom_id: int,
    to_uom_id: int,
    quantity: Decimal = Query(1),
    item_id: int = Query(None),
    as_of: datetime = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    await ensure_uom_enterprise_schema(db)
    if from_uom_id == to_uom_id:
        return {"quantity": str(quantity), "factor": "1", "path": [from_uom_id]}
    from_uom, to_uom = await _load_uom_pair(db, from_uom_id, to_uom_id)
    if from_uom.category_id != to_uom.category_id and not item_id:
        raise HTTPException(status_code=422, detail="Cross-category conversion requires item_id")
    factor, path = await _find_conversion_factor(db, from_uom_id, to_uom_id, item_id=item_id, as_of=as_of or _utcnow())
    if factor is None:
        raise HTTPException(status_code=404, detail="No conversion route found")
    return {
        "quantity": str(quantity * factor),
        "factor": str(factor),
        "path": path,
        "item_id": item_id,
    }


@router.get("/item-uom-conversions")
async def list_item_uom_conversions(
    item_id: int = Query(None),
    include_history: bool = Query(False),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    await ensure_uom_enterprise_schema(db)
    as_of = _utcnow()
    q = select(ItemUOMConversion).order_by(ItemUOMConversion.item_id, ItemUOMConversion.from_uom_id)
    if item_id is not None:
        q = q.where(ItemUOMConversion.item_id == item_id)
    if not include_history:
        q = q.where(
            ItemUOMConversion.is_active == True,  # noqa: E712
            ItemUOMConversion.valid_from <= as_of,
            or_(ItemUOMConversion.valid_to.is_(None), ItemUOMConversion.valid_to > as_of),
        )
    rows = (await db.execute(q)).scalars().all()
    uom_ids = {r.from_uom_id for r in rows} | {r.to_uom_id for r in rows}
    item_ids = {r.item_id for r in rows}
    uom_map = {}
    item_map = {}
    if uom_ids:
        uom_rows = (await db.execute(select(UOM).where(UOM.id.in_(uom_ids)))).scalars().all()
        uom_map = {row.id: row for row in uom_rows}
    if item_ids:
        item_rows = (await db.execute(select(Item.id, Item.name, Item.item_code).where(Item.id.in_(item_ids)))).all()
        item_map = {row.id: row for row in item_rows}
    return [
        {
            "id": row.id,
            "item_id": row.item_id,
            "item_name": item_map.get(row.item_id).name if row.item_id in item_map else None,
            "item_code": item_map.get(row.item_id).item_code if row.item_id in item_map else None,
            "from_uom_id": row.from_uom_id,
            "to_uom_id": row.to_uom_id,
            "from_uom_name": uom_map.get(row.from_uom_id).name if row.from_uom_id in uom_map else None,
            "to_uom_name": uom_map.get(row.to_uom_id).name if row.to_uom_id in uom_map else None,
            "conversion_type": row.conversion_type,
            "factor_num": str(row.factor_num),
            "factor_den": str(row.factor_den),
            "conversion_factor": str(row.conversion_factor),
            "valid_from": row.valid_from,
            "valid_to": row.valid_to,
            "is_active": row.is_active,
        }
        for row in rows
    ]


@router.post("/item-uom-conversions", status_code=201)
async def create_item_uom_conversion(
    payload: ItemUOMConversionCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    await ensure_uom_enterprise_schema(db)
    item = (await db.execute(select(Item).where(Item.id == payload.item_id, Item.is_active == True))).scalar_one_or_none()  # noqa: E712
    if not item:
        raise HTTPException(status_code=422, detail="Item does not exist or is inactive")
    await _load_uom_pair(db, payload.from_uom_id, payload.to_uom_id)
    factor_num, factor_den, factor = _factor_parts(payload)
    active = (
        await db.execute(
            select(ItemUOMConversion).where(
                ItemUOMConversion.item_id == payload.item_id,
                ItemUOMConversion.from_uom_id == payload.from_uom_id,
                ItemUOMConversion.to_uom_id == payload.to_uom_id,
                ItemUOMConversion.is_active == True,  # noqa: E712
                or_(ItemUOMConversion.valid_to.is_(None), ItemUOMConversion.valid_to > (payload.valid_from or _utcnow())),
            )
        )
    ).scalar_one_or_none()
    if active:
        raise HTTPException(status_code=409, detail="Active item UOM conversion for this pair already exists")
    row = ItemUOMConversion(
        item_id=payload.item_id,
        from_uom_id=payload.from_uom_id,
        to_uom_id=payload.to_uom_id,
        conversion_type=payload.conversion_type,
        factor_num=factor_num,
        factor_den=factor_den,
        conversion_factor=factor,
        valid_from=payload.valid_from or _utcnow(),
        valid_to=payload.valid_to,
        is_active=True if payload.is_active is None else bool(payload.is_active),
    )
    db.add(row)
    await db.flush()
    return {"id": row.id, "message": "Item UOM conversion created"}


@router.put("/item-uom-conversions/{conv_id}")
async def update_item_uom_conversion(
    conv_id: int,
    payload: ItemUOMConversionCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    await ensure_uom_enterprise_schema(db)
    row = (await db.execute(select(ItemUOMConversion).where(ItemUOMConversion.id == conv_id))).scalar_one_or_none()
    if not row:
        raise HTTPException(status_code=404, detail="Item UOM conversion not found")
    factor_num, factor_den, factor = _factor_parts(payload)
    now = _utcnow()
    row.valid_to = now
    row.is_active = False
    db.add(ItemUOMConversion(
        item_id=payload.item_id,
        from_uom_id=payload.from_uom_id,
        to_uom_id=payload.to_uom_id,
        conversion_type=payload.conversion_type,
        factor_num=factor_num,
        factor_den=factor_den,
        conversion_factor=factor,
        valid_from=payload.valid_from or now,
        valid_to=payload.valid_to,
        is_active=True if payload.is_active is None else bool(payload.is_active),
    ))
    await db.flush()
    return {"id": conv_id, "message": "Item UOM conversion superseded with a new effective-dated row"}


@router.delete("/item-uom-conversions/{conv_id}")
async def delete_item_uom_conversion(
    conv_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    await ensure_uom_enterprise_schema(db)
    row = (await db.execute(select(ItemUOMConversion).where(ItemUOMConversion.id == conv_id))).scalar_one_or_none()
    if not row:
        raise HTTPException(status_code=404, detail="Item UOM conversion not found")
    row.is_active = False
    row.valid_to = _utcnow()
    await db.flush()
    return {"message": "Item UOM conversion expired"}

async def _get_parent_category_ids(db: AsyncSession, category_id: int) -> list[int]:
    """Return a list of category IDs including the given ID and all its parents."""
    ids = [category_id]
    current_id = category_id
    # Max depth safety to prevent infinite loops if circularity exists
    for _ in range(20):
        res = await db.execute(select(ItemCategory.parent_id).where(ItemCategory.id == current_id))
        pid = res.scalar_one_or_none()
        if pid and pid not in ids:
            ids.append(pid)
            current_id = pid
        else:
            break
    return ids


async def _get_descendant_category_ids(db: AsyncSession, category_id: int) -> list[int]:
    """Return a list of category IDs including the given ID and all its active descendants."""
    ids = [category_id]
    # Level 1 to 2
    res = await db.execute(
        select(ItemCategory.id)
        .where(ItemCategory.parent_id == category_id, ItemCategory.is_active == True)
    )
    level2_ids = [row[0] for row in res.all()]
    if level2_ids:
        ids.extend(level2_ids)
        # Level 2 to 3
        res3 = await db.execute(
            select(ItemCategory.id)
            .where(ItemCategory.parent_id.in_(level2_ids), ItemCategory.is_active == True)
        )
        level3_ids = [row[0] for row in res3.all()]
        if level3_ids:
            ids.extend(level3_ids)
    return ids



async def _category_level(db: AsyncSession, parent_id: int | None) -> int:
    if not parent_id:
        return 1
    parent = (await db.execute(select(ItemCategory).where(ItemCategory.id == parent_id))).scalar_one_or_none()
    if not parent:
        raise HTTPException(status_code=422, detail="Parent category not found")
    if (parent.level or 1) >= 3:
        raise HTTPException(status_code=422, detail="Only three category levels are allowed")
    return (parent.level or 1) + 1


async def _category_full_code(db: AsyncSession, short_code: str, parent_id: int | None) -> str:
    short_code = (short_code or "").strip()
    if not re.match(r"^[1-9][0-9]$", short_code):
        raise HTTPException(status_code=422, detail="Short code must be a two-digit number from 10 to 99")
    if not parent_id:
        return short_code
    parent = (await db.execute(select(ItemCategory).where(ItemCategory.id == parent_id))).scalar_one_or_none()
    if not parent:
        raise HTTPException(status_code=422, detail="Parent category not found")
    if not parent.full_code:
        raise HTTPException(status_code=422, detail="Parent category is missing full code")
    full_code = f"{parent.full_code}{short_code}"
    if len(full_code) > 6:
        raise HTTPException(status_code=422, detail="Only three category levels are allowed")
    return full_code


async def _refresh_descendant_full_codes(db: AsyncSession, category: ItemCategory) -> None:
    children = (
        await db.execute(select(ItemCategory).where(ItemCategory.parent_id == category.id))
    ).scalars().all()
    for child in children:
        child.level = (category.level or 1) + 1
        child.full_code = f"{category.full_code}{child.short_code}"
        if len(child.full_code or "") > 6:
            raise HTTPException(status_code=422, detail="Only three category levels are allowed")
        await _refresh_descendant_full_codes(db, child)


async def _generate_category_short_code(db: AsyncSession, parent_id: int | None) -> str:
    """Generate the next available two-digit short code (10-99) under the given parent."""
    res = await db.execute(
        select(ItemCategory.short_code)
        .where(ItemCategory.parent_id == parent_id)
    )
    existing_codes = {int(code) for (code,) in res if code and code.isdigit()}
    # Start from 10
    for code in range(10, 100):
        if code not in existing_codes:
            return f"{code:02d}"
    raise HTTPException(status_code=422, detail="No more short codes available under this parent (max 90 categories allowed)")


def _readable_token(value: str | None, max_len: int | None = None) -> str:
    raw = (value or "").strip()
    if not raw:
        token = "GEN"
    else:
        import unicodedata
        ascii_value = unicodedata.normalize("NFKD", raw).encode("ascii", "ignore").decode("ascii")
        token = re.sub(r"[^A-Z0-9]+", "-", ascii_value.upper()).strip("-") or "GEN"
    return token[:max_len] if max_len else token


def _category_readable_code(name: str | None, code: str | None = None) -> str:
    cleaned = re.sub(r"-\d{3,}$", "", (code or "").strip().upper())
    if cleaned and not re.fullmatch(r"\d+", cleaned):
        return cleaned
    return _readable_token(name, 3)


async def _unique_category_code(db: AsyncSession, base: str, category_id: int | None = None) -> str:
    code = (base or "CAT").strip().upper()
    suffix = ""
    attempt = code
    while True:
        query = select(ItemCategory.id).where(func.lower(ItemCategory.code) == attempt.lower())
        if category_id:
            query = query.where(ItemCategory.id != category_id)
        exists = (await db.execute(query)).scalar_one_or_none()
        if not exists:
            return attempt
        suffix += chr(ord("A") + len(suffix))
        attempt = f"{code}{suffix}"


async def _category_readable_chain(db: AsyncSession, category_id: int | None) -> list[str]:
    if not category_id:
        return ["GEN"]
    rows = (await db.execute(select(ItemCategory))).scalars().all()
    by_id = {int(row.id): row for row in rows}
    chain = []
    current = by_id.get(int(category_id))
    seen = set()
    while current and int(current.id) not in seen:
        seen.add(int(current.id))
        chain.append(_category_readable_code(current.name, current.code))
        current = by_id.get(int(current.parent_id)) if current.parent_id else None
    
    # chain is leaf-to-root, reverse it to get root-to-leaf order
    ordered = list(reversed(chain))
    
    # Deduplicate redundant parent prefixes
    resolved = []
    prev_code = ""
    for code in ordered:
        if prev_code:
            prefix = f"{prev_code}-"
            if code.startswith(prefix):
                relative = code[len(prefix):]
            elif code == prev_code:
                relative = ""
            else:
                relative = code
        else:
            relative = code
        if relative:
            resolved.append(relative)
        prev_code = code
    return resolved or ["GEN"]


async def _item_readable_code(db: AsyncSession, category_id: int | None, item_name: str | None) -> str:
    chain = await _category_readable_chain(db, category_id)
    raw = (item_name or "").strip()
    if not raw:
        item_token = "GEN"
    else:
        import unicodedata
        ascii_value = unicodedata.normalize("NFKD", raw).encode("ascii", "ignore").decode("ascii")
        item_token = re.sub(r"[^A-Z0-9 ]+", "", ascii_value.upper()).strip() or "GEN"
    return "-".join([*chain, item_token])


# ==================== ITEM CATEGORIES ====================

@router.get("/categories")
async def list_categories(
    search: str = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    await ensure_item_category_code_schema(db)
    query = select(ItemCategory).where(ItemCategory.is_active == True).order_by(ItemCategory.name)
    query = apply_search_filter(query, ItemCategory, search, ["name", "code"])
    result = await db.execute(query)
    items = result.scalars().all()
    return [CategoryResponse.model_validate(i) for i in items]


@router.post("/categories", status_code=201)
async def create_category(
    payload: CategoryCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    await ensure_item_category_code_schema(db)
    data = payload.model_dump()
    
    # Auto-generate short_code if missing
    if not data.get("short_code"):
        data["short_code"] = await _generate_category_short_code(db, data.get("parent_id"))

    data["level"] = await _category_level(db, data.get("parent_id"))
    data["full_code"] = await _category_full_code(db, data["short_code"], data.get("parent_id"))
    
    dup_short = await db.execute(
        select(ItemCategory).where(
            ItemCategory.parent_id == data.get("parent_id"),
            ItemCategory.short_code == data["short_code"],
        )
    )
    if dup_short.scalar_one_or_none():
        raise HTTPException(status_code=409, detail=f"Short code '{data['short_code']}' already exists under this parent")
    
    dup_full = await db.execute(select(ItemCategory).where(ItemCategory.full_code == data["full_code"]))
    if dup_full.scalar_one_or_none():
        raise HTTPException(status_code=409, detail=f"Full code '{data['full_code']}' already exists")
    # Auto-generate readable category code if not provided, e.g. Laboratory Supplies -> LAB.
    if not data.get("code"):
        data["code"] = await _unique_category_code(db, _category_readable_code(data.get("name")))
    # BUG-FE-043: case-insensitive uniqueness check
    code_val = _category_readable_code(data.get("name"), data.get("code"))
    existing = await db.execute(
        select(ItemCategory).where(func.lower(ItemCategory.code) == code_val.lower())
    )
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=409, detail=f"Category with code '{code_val}' already exists")
    data["code"] = code_val
    cat = ItemCategory(**data)
    db.add(cat)
    await db.flush()
    return {"id": cat.id, "message": "Category created"}


@router.put("/categories/{category_id}")
async def update_category(
    category_id: int,
    payload: CategoryCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    await ensure_item_category_code_schema(db)
    result = await db.execute(select(ItemCategory).where(ItemCategory.id == category_id))
    cat = result.scalar_one_or_none()
    if not cat:
        raise HTTPException(status_code=404, detail="Category not found")
    update_data = payload.model_dump(exclude_unset=True)
    parent_id = update_data.get("parent_id", cat.parent_id)
    short_code = update_data.get("short_code", cat.short_code)
    if "parent_id" in update_data or "short_code" in update_data:
        update_data["level"] = await _category_level(db, parent_id)
        update_data["full_code"] = await _category_full_code(db, short_code, parent_id)
        dup_short = await db.execute(
            select(ItemCategory).where(
                ItemCategory.parent_id == parent_id,
                ItemCategory.short_code == short_code,
                ItemCategory.id != category_id,
            )
        )
        if dup_short.scalar_one_or_none():
            raise HTTPException(status_code=409, detail=f"Short code '{short_code}' already exists under this parent")
        dup_full = await db.execute(
            select(ItemCategory).where(ItemCategory.full_code == update_data["full_code"], ItemCategory.id != category_id)
        )
        if dup_full.scalar_one_or_none():
            raise HTTPException(status_code=409, detail=f"Full code '{update_data['full_code']}' already exists")
    # BUG-FE-046: never clear a NOT NULL column with empty string from PUT.
    if "code" in update_data:
        new_code = (update_data["code"] or "").strip()
        if not new_code:
            update_data.pop("code")
        else:
            new_code = _category_readable_code(update_data.get("name", cat.name), new_code)
            # BUG-FE-043: case-insensitive duplicate check on rename
            dup = await db.execute(
                select(ItemCategory).where(
                    func.lower(ItemCategory.code) == new_code.lower(),
                    ItemCategory.id != category_id,
                )
            )
            if dup.scalar_one_or_none():
                raise HTTPException(status_code=409, detail=f"Category with code '{new_code}' already exists")
            update_data["code"] = new_code
    elif "name" in update_data:
        update_data["code"] = await _unique_category_code(db, _category_readable_code(update_data.get("name")), category_id)
    # BUG-FE-041: refuse silent deactivate via PUT when items still reference it
    if update_data.get("is_active") is False and cat.is_active is True:
        item_count = (await db.execute(
            select(func.count(Item.id)).where(Item.category_id == category_id, Item.is_active == True)
        )).scalar() or 0
        if item_count > 0:
            raise HTTPException(
                status_code=409,
                detail=f"Cannot deactivate category â€” {item_count} active item(s) still reference it. Use the dedicated delete endpoint with explicit confirmation.",
            )
    for k, v in update_data.items():
        setattr(cat, k, v)
    if "parent_id" in update_data or "short_code" in update_data:
        await _refresh_descendant_full_codes(db, cat)
    await db.flush()
    return {"success": True, "message": "Category updated"}


@router.delete("/categories/{category_id}")
async def delete_category(
    category_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    result = await db.execute(select(ItemCategory).where(ItemCategory.id == category_id))
    cat = result.scalar_one_or_none()
    if not cat:
        raise HTTPException(status_code=404, detail="Category not found")
    # Check if items exist in this category
    item_count = (await db.execute(select(func.count(Item.id)).where(Item.category_id == category_id))).scalar()
    if item_count > 0:
        raise HTTPException(status_code=409, detail=f"Cannot delete category with {item_count} items. Move or delete items first.")
    # Check for child categories
    child_count = (await db.execute(select(func.count(ItemCategory.id)).where(ItemCategory.parent_id == category_id))).scalar()
    if child_count > 0:
        raise HTTPException(status_code=409, detail=f"Cannot delete category with {child_count} sub-categories. Delete sub-categories first.")
    cat.is_active = False
    await db.flush()
    return {"success": True, "message": "Category deactivated"}

async def _check_items_view_permission(db: AsyncSession, current_user: User) -> None:
    """BUG-FE-001: items expose price/MRP/HSN — gate to roles that legitimately
    need this. Mirrors vendor pattern in list_vendors."""
    from app.utils.dependencies import check_user_has_any_permission
    has_perm = await check_user_has_any_permission(
        db,
        current_user.id,
        [
            ("inventory", "view", "items"),
            ("masters", "view", "items"),
            ("procurement", "view", "purchase-orders"),
            ("procurement", "view", "material-requests"),
            ("procurement", "view", "quotations"),
            ("indent", "view", "indents"),
            ("consumption", "view", "entry"),
            ("warehouse", "view", "grn"),
            ("warehouse", "view", "stock"),
            ("warehouse", "view", "bins"),
            ("inventory", "view", "stock-balance"),
            ("inventory", "view", "stock-ledger"),
            ("accounts", "view", "invoices"),
            ("sales", "view", "orders"),
            ("sales", "view", "invoices")
        ]
    )
    if not has_perm:
        raise HTTPException(status_code=403, detail="Permission denied: masters.view.items")


def _normalize_feature_ids(values: list[int] | None) -> list[int]:
    if not values:
        return []
    out = []
    seen = set()
    for v in values:
        try:
            fid = int(v)
        except (TypeError, ValueError):
            continue
        if fid <= 0 or fid in seen:
            continue
        seen.add(fid)
        out.append(fid)
    return out


async def _validate_item_features(
    db: AsyncSession,
    category_id: int | None,
    feature_ids: list[int],
) -> list[int]:
    normalized = _normalize_feature_ids(feature_ids)
    if not normalized:
        return []
    if category_id is None:
        raise HTTPException(status_code=422, detail="Category is required when selecting features")
    
    # Hierarchical feature check: get all parent category IDs
    valid_category_ids = await _get_parent_category_ids(db, category_id)
    
    rows = (await db.execute(select(Feature).where(Feature.id.in_(normalized)))).scalars().all()
    found = {f.id: f for f in rows}
    for fid in normalized:
        feature = found.get(fid)
        if not feature or not feature.is_active:
            raise HTTPException(status_code=422, detail=f"Feature {fid} does not exist or is inactive")
        if feature.category_id not in valid_category_ids:
            raise HTTPException(
                status_code=422,
                detail=f"Feature {feature.name} does not belong to the selected category or its parents",
            )
    return normalized


async def _replace_item_features(db: AsyncSession, item_id: int, feature_ids: list[int]) -> None:
    existing = (await db.execute(select(ItemFeature).where(ItemFeature.item_id == item_id))).scalars().all()
    for row in existing:
        await db.delete(row)
    for fid in feature_ids:
        db.add(ItemFeature(item_id=item_id, feature_id=fid))


async def _item_feature_ids(db: AsyncSession, item_id: int) -> list[int]:
    rows = (await db.execute(
        select(ItemFeature.feature_id).where(ItemFeature.item_id == item_id).order_by(ItemFeature.id)
    )).all()
    return [int(r[0]) for r in rows]


def _feature_payload(feature: Feature | None) -> dict | None:
    if not feature:
        return None
    return {
        "id": int(feature.id),
        "name": feature.name,
        "category_id": int(feature.category_id) if feature.category_id is not None else None,
        "is_active": bool(feature.is_active),
    }


def _resolve_feature_ids_for_item(item: Item, item_feature_map: dict[int, list[int]]) -> list[int]:
    ids = list(item_feature_map.get(int(item.id), []))
    if not ids and item.feature_id:
        ids = [int(item.feature_id)]
    return ids


async def _load_feature_maps_for_items(
    db: AsyncSession,
    item_ids: list[int],
    fallback_feature_ids: list[int],
) -> tuple[dict[int, list[int]], dict[int, Feature]]:
    item_feature_map: dict[int, list[int]] = {}
    feature_ids: set[int] = {int(fid) for fid in fallback_feature_ids if fid}

    if item_ids:
        rows = (
            await db.execute(
                select(ItemFeature.item_id, ItemFeature.feature_id)
                .where(ItemFeature.item_id.in_(item_ids))
                .order_by(ItemFeature.id)
            )
        ).all()
        for item_id, feature_id in rows:
            iid = int(item_id)
            fid = int(feature_id)
            item_feature_map.setdefault(iid, []).append(fid)
            feature_ids.add(fid)

    feature_map: dict[int, Feature] = {}
    if feature_ids:
        features = (await db.execute(select(Feature).where(Feature.id.in_(feature_ids)))).scalars().all()
        feature_map = {int(f.id): f for f in features}
    return item_feature_map, feature_map


async def _normalize_item_uom_category(db: AsyncSession, data: dict) -> None:
    category_id = data.get("uom_category_id")
    primary_uom_id = data.get("primary_uom_id")
    if not primary_uom_id:
        return

    row = (await db.execute(select(UOM.id, UOM.category_id).where(UOM.id == primary_uom_id))).first()
    if not row:
        raise HTTPException(status_code=422, detail="Primary UOM not found")

    uom_category_id = row.category_id
    if category_id and uom_category_id and int(category_id) != int(uom_category_id):
        raise HTTPException(status_code=422, detail="Primary UOM must belong to the selected UOM Category")
    if not category_id:
        data["uom_category_id"] = uom_category_id


def _kit_component_suffix(index: int) -> str:
    value = index + 1  # first component starts at b, matching 101010-0001-b
    chars = []
    while value >= 0:
        chars.append(chr(ord("a") + (value % 26)))
        value = (value // 26) - 1
    return "".join(reversed(chars))


def _kit_component_code(item_code: str | None, index: int) -> str | None:
    base = (item_code or "").strip()
    if not base:
        return None
    return f"{base}-{_kit_component_suffix(index)}".lower()


def _kit_component_payload(component: MasterItemKitComponent) -> dict:
    uom = getattr(component, "uom", None)
    return {
        "id": component.id,
        "item_id": component.item_id,
        "component_code": component.component_code,
        "component_name": component.component_name,
        "quantity": component.quantity,
        "uom_id": component.uom_id,
        "uom_name": uom.name if uom else None,
        "uom_abbreviation": uom.abbreviation if uom else None,
        "sort_order": component.sort_order,
        "remarks": component.remarks,
    }


def _kit_component_value(component, field: str, default=None):
    if isinstance(component, dict):
        return component.get(field, default)
    return getattr(component, field, default)


async def _replace_item_kit_components(
    db: AsyncSession,
    item_id: int,
    is_kit: bool,
    components,
    item_code: str | None = None,
) -> None:
    await db.execute(delete(MasterItemKitComponent).where(MasterItemKitComponent.item_id == item_id))
    if not is_kit:
        return
    if not components:
        return

    uom_ids = {int(_kit_component_value(c, "uom_id")) for c in components if _kit_component_value(c, "uom_id")}
    if uom_ids:
        rows = await db.execute(select(UOM.id).where(UOM.id.in_(uom_ids)))
        found = {int(r[0]) for r in rows.all()}
        missing = sorted(uom_ids - found)
        if missing:
            raise HTTPException(status_code=422, detail=f"Unknown UOM id(s) in kit components: {missing}")

    for idx, component in enumerate(components, start=1):
        db.add(MasterItemKitComponent(
            item_id=item_id,
            component_code=_kit_component_code(item_code, idx - 1),
            component_name=_kit_component_value(component, "component_name"),
            quantity=_kit_component_value(component, "quantity"),
            uom_id=_kit_component_value(component, "uom_id"),
            sort_order=_kit_component_value(component, "sort_order") or idx,
            remarks=_kit_component_value(component, "remarks"),
        ))



@router.get("/items")
async def list_items(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=10000),
    search: str = Query(None),
    category_id: int = Query(None),
    feature_id: int = Query(None),
    item_type: str = Query(None),
    is_active: bool = Query(None),
    transactable: bool = Query(False, description="Only items usable in indent/MR/PO/MI flows: active + has UOM + has code + has name"),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    await ensure_feature_schema(db)
    await ensure_item_uom_category_schema(db)
    await ensure_item_category_code_schema(db)
    await _check_items_view_permission(db, current_user)
    offset, limit = paginate_params(page, page_size)
    query = select(Item)
    count_query = select(func.count(Item.id))

    if transactable:
        # 2026-05-06 â€” guard transactional flows from items missing the
        # fields required to create a line: UOM, item_code, name. Active
        # check applies regardless of the is_active param when transactable
        # is on, because an inactive item can't transact.
        query = (
            query.where(Item.is_active == True)
                 .where(Item.primary_uom_id.is_not(None))
                 .where(Item.item_code.is_not(None)).where(Item.item_code != "")
                 .where(Item.name.is_not(None)).where(Item.name != "")
        )
        count_query = (
            count_query.where(Item.is_active == True)
                       .where(Item.primary_uom_id.is_not(None))
                       .where(Item.item_code.is_not(None)).where(Item.item_code != "")
                       .where(Item.name.is_not(None)).where(Item.name != "")
        )

    if category_id:
        descendant_ids = await _get_descendant_category_ids(db, category_id)
        query = query.where(Item.category_id.in_(descendant_ids))
        count_query = count_query.where(Item.category_id.in_(descendant_ids))
    if feature_id:
        feature_match = select(ItemFeature.id).where(
            ItemFeature.item_id == Item.id,
            ItemFeature.feature_id == feature_id,
        ).exists()
        query = query.where((Item.feature_id == feature_id) | feature_match)
        count_query = count_query.where((Item.feature_id == feature_id) | feature_match)
    if item_type:
        query = query.where(Item.item_type == item_type)
        count_query = count_query.where(Item.item_type == item_type)
    # BUG-FE-008: default to active-only listing unless caller explicitly passes
    # is_active=false (admin "show inactive" toggle). Without this default the
    # main grid silently surfaces deactivated items.
    if is_active is None:
        query = query.where(Item.is_active == True)
        count_query = count_query.where(Item.is_active == True)
    else:
        query = query.where(Item.is_active == is_active)
        count_query = count_query.where(Item.is_active == is_active)

    query = apply_search_filter(query, Item, search, ["item_code", "readable_code", "name", "sku", "hsn_code"])
    count_query = apply_search_filter(count_query, Item, search, ["item_code", "readable_code", "name", "sku", "hsn_code"])

    total = (await db.execute(count_query)).scalar()
    from sqlalchemy.orm import selectinload
    result = await db.execute(
        query.options(
            selectinload(Item.primary_uom),
            selectinload(Item.category),
            selectinload(Item.uom_category),
            selectinload(Item.feature),
            selectinload(Item.sub_class),
            selectinload(Item.kit_components).selectinload(MasterItemKitComponent.uom),
        )
        .offset(offset).limit(limit).order_by(Item.id.desc())
    )
    items = result.scalars().all()
    item_ids = [int(i.id) for i in items]
    fallback_feature_ids = [int(i.feature_id) for i in items if i.feature_id]
    item_feature_map, feature_map = await _load_feature_maps_for_items(db, item_ids, fallback_feature_ids)

    # In-memory category hierarchy lookup helper to avoid N+1 queries
    from app.models.inventory_master import ItemCategory
    cat_rows = (await db.execute(select(ItemCategory))).scalars().all()
    cat_map = {c.id: c for c in cat_rows}

    def get_cat_hierarchy(category_id: int | None) -> dict:
        hierarchy = {"level1": None, "level2": None, "level3": None}
        if not category_id:
            return hierarchy
        current_id = category_id
        for _ in range(3):
            if not current_id:
                break
            cat = cat_map.get(current_id)
            if not cat:
                break
            if cat.level == 1:
                hierarchy["level1"] = cat.name
            elif cat.level == 2:
                hierarchy["level2"] = cat.name
            elif cat.level == 3:
                hierarchy["level3"] = cat.name
            current_id = cat.parent_id
        return hierarchy

    # Enrich response with UOM and category names for frontend
    response_items = []
    for i in items:
        data = ItemResponse.model_validate(i).model_dump()
        feature_ids = _resolve_feature_ids_for_item(i, item_feature_map)
        feature_names = [feature_map[fid].name for fid in feature_ids if fid in feature_map]
        primary_feature = feature_map.get(feature_ids[0]) if feature_ids else i.feature
        data["primary_uom_name"] = i.primary_uom.name if i.primary_uom else None
        data["primary_uom"] = {"id": i.primary_uom.id, "name": i.primary_uom.name, "abbreviation": i.primary_uom.abbreviation, "category_id": i.primary_uom.category_id} if i.primary_uom else None
        data["category_name"] = i.category.name if i.category else None
        data["category"] = {"id": i.category.id, "name": i.category.name, "code": i.category.code} if i.category else None
        data["uom_category_name"] = i.uom_category.name if i.uom_category else None
        
        # Category hierarchy path
        hierarchy = get_cat_hierarchy(i.category_id)
        data["category_l1"] = hierarchy["level1"]
        data["category_l2"] = hierarchy["level2"]
        data["category_l3"] = hierarchy["level3"]

        data["feature_id"] = feature_ids[0] if feature_ids else None
        data["feature_ids"] = feature_ids
        data["feature_names"] = feature_names
        data["feature_name"] = feature_names[0] if feature_names else (i.feature.name if i.feature else None)
        data["feature"] = _feature_payload(primary_feature)
        data["kit_components"] = [
            _kit_component_payload(c)
            for c in sorted(i.kit_components or [], key=lambda row: (row.sort_order or 0, row.id or 0))
        ]
        response_items.append(data)

    return build_paginated_response(response_items, total, page, page_size)


async def _resolve_category_hierarchy(db: AsyncSession, category_id: int | None) -> dict:
    hierarchy = {"level1": None, "level2": None, "level3": None}
    if not category_id:
        return hierarchy
    from app.models.inventory_master import ItemCategory
    current_id = category_id
    for _ in range(3):
        if not current_id:
            break
        row = (await db.execute(select(ItemCategory).where(ItemCategory.id == current_id))).scalar_one_or_none()
        if not row:
            break
        if row.level == 1:
            hierarchy["level1"] = row.name
        elif row.level == 2:
            hierarchy["level2"] = row.name
        elif row.level == 3:
            hierarchy["level3"] = row.name
        current_id = row.parent_id
    return hierarchy


@router.get("/items/{item_id}", response_model=ItemResponse)
async def get_item(
    item_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    await ensure_feature_schema(db)
    await ensure_item_uom_category_schema(db)
    await ensure_item_category_code_schema(db)
    await _check_items_view_permission(db, current_user)
    from sqlalchemy.orm import selectinload
    result = await db.execute(
        select(Item)
        .options(
            selectinload(Item.primary_uom),
            selectinload(Item.category),
            selectinload(Item.uom_category),
            selectinload(Item.sub_class),
            selectinload(Item.kit_components).selectinload(MasterItemKitComponent.uom),
        )
        .where(Item.id == item_id)
    )
    item = result.scalar_one_or_none()
    if not item:
        raise HTTPException(status_code=404, detail="Item not found")
    item_feature_map, feature_map = await _load_feature_maps_for_items(
        db,
        [int(item.id)],
        [int(item.feature_id)] if item.feature_id else [],
    )
    feature_ids = _resolve_feature_ids_for_item(item, item_feature_map)
    feature_names = [feature_map[fid].name for fid in feature_ids if fid in feature_map]
    data = ItemResponse.model_validate(item).model_dump()
    if item.primary_uom:
        data["primary_uom_name"] = item.primary_uom.name
        data["primary_uom"] = {"id": item.primary_uom.id, "name": item.primary_uom.name, "abbreviation": item.primary_uom.abbreviation, "category_id": item.primary_uom.category_id}
    if item.category:
        data["category_name"] = item.category.name
        data["category"] = {"id": item.category.id, "name": item.category.name, "code": item.category.code}
    if item.uom_category:
        data["uom_category_name"] = item.uom_category.name
        data["uom_category"] = {"id": item.uom_category.id, "name": item.uom_category.name}
    
    # Resolve category hierarchy levels L1, L2, L3
    hierarchy = await _resolve_category_hierarchy(db, item.category_id)
    data["category_l1"] = hierarchy["level1"]
    data["category_l2"] = hierarchy["level2"]
    data["category_l3"] = hierarchy["level3"]

    data["feature_id"] = feature_ids[0] if feature_ids else None
    data["feature_ids"] = feature_ids
    data["feature_names"] = feature_names
    data["kit_components"] = [
        _kit_component_payload(c)
        for c in sorted(item.kit_components or [], key=lambda row: (row.sort_order or 0, row.id or 0))
    ]
    return data


@router.post("/items", status_code=201)
async def create_item(
    payload: ItemCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_permission("masters", "create", "items")),
):
    """Item code auto-generates as L1L2L3-SEQ, e.g. 101010-0001,
    if the user leaves it blank or sends 'AUTO'. A user-supplied code is
    accepted as 'manual' (must still be unique).
    """
    from app.services.item_coding import (
        generate_item_code, normalize_form_code, ORG_PREFIX_DEFAULT,
    )

    await ensure_feature_schema(db)
    await ensure_item_uom_category_schema(db)
    data = payload.model_dump()

    brand_val = data.get("brand")
    if brand_val:
        from app.models.inventory_master import Brand
        brand_obj = None
        if str(brand_val).isdigit():
            brand_obj = (await db.execute(select(Brand).where(Brand.id == int(brand_val)))).scalar_one_or_none()
        if not brand_obj:
            brand_obj = (await db.execute(select(Brand).where(func.lower(Brand.code) == str(brand_val).lower()))).scalar_one_or_none()
        if brand_obj:
            data["brand"] = brand_obj.code
    kit_components = data.pop("kit_components", None)
    initial_quantity = data.pop("initial_quantity", None)
    initial_warehouse_id = data.pop("initial_warehouse_id", None)
    initial_bin_code = data.pop("initial_bin_code", None)
    initial_batch_number = data.pop("initial_batch_number", None)
    initial_batch_expiry = data.pop("initial_batch_expiry", None)
    requested_feature_ids = data.pop("feature_ids", None)
    if requested_feature_ids is None:
        requested_feature_ids = [data.get("feature_id")] if data.get("feature_id") is not None else []
    validated_feature_ids = await _validate_item_features(db, data.get("category_id"), requested_feature_ids)
    data["feature_id"] = validated_feature_ids[0] if validated_feature_ids else None
    await _normalize_item_uom_category(db, data)
    # Normalize optional text fields that users frequently paste with spaces.

    user_code = (data.get("item_code") or "").strip()

    # Auto-generate when blank or sentinel
    if not user_code or user_code.upper() == "AUTO":
        try:
            data["item_code"] = await generate_item_code(
                db,
                category_id=data.get("category_id"),
                dosage_form=data.get("dosage_form"),
                org_prefix=ORG_PREFIX_DEFAULT,
            )
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        data["coding_status"] = "auto"
    else:
        # Manual code â€” verify uniqueness (case-insensitive, BUG-FE-002)
        existing = await db.execute(
            select(Item).where(func.lower(Item.item_code) == user_code.lower())
        )
        if existing.scalar_one_or_none():
            raise HTTPException(status_code=409, detail=f"Item with code '{user_code}' already exists. Please use a unique item code.")
        # Normalize to uppercase to keep new codes consistent with existing ones
        data["item_code"] = user_code.upper()
        data["coding_status"] = "manual"

    existing_name = await db.execute(
        select(Item.id).where(func.lower(Item.name) == str(data.get("name") or "").strip().lower())
    )
    if existing_name.scalar_one_or_none():
        raise HTTPException(status_code=409, detail=f"Item with name '{data.get('name')}' already exists. Please use a unique item name.")

    # Always populate the form code if dosage_form is set
    if data.get("dosage_form"):
        data["dosage_form_code"] = normalize_form_code(data["dosage_form"])
    data["readable_code"] = await _item_readable_code(db, data.get("category_id"), data.get("name"))

    item = Item(**data, created_by=current_user.id)
    if payload.item_type == "equipment" and not payload.dosage_form:
        item.dosage_form = "unit"
    db.add(item)
    try:
        await db.flush()
        await _replace_item_features(db, int(item.id), validated_feature_ids)
        await _replace_item_kit_components(db, int(item.id), bool(item.is_kit), kit_components, item.item_code)
        if initial_quantity is not None and Decimal(str(initial_quantity)) > 0:
            warehouse = None
            if initial_warehouse_id:
                wh_result = await db.execute(select(Warehouse).where(Warehouse.id == initial_warehouse_id, Warehouse.is_active == True))
                warehouse = wh_result.scalar_one_or_none()
            if not warehouse:
                wh_result = await db.execute(select(Warehouse).where(func.lower(Warehouse.name) == "central"))
                warehouse = wh_result.scalar_one_or_none()
            if not warehouse:
                fallback_result = await db.execute(select(Warehouse).where(Warehouse.is_active == True).limit(1))
                warehouse = fallback_result.scalar_one_or_none()
            if warehouse:
                # Resolve or create the bin using initial_bin_code
                bin_code = (initial_bin_code or "SYSTEM-DEFAULT").strip()
                from app.api.v1.warehouse import resolve_or_create_bin
                bin_id = await resolve_or_create_bin(db, warehouse.id, bin_code)

                # Resolve or create the batch using initial_batch_number
                from app.models.warehouse import Batch
                batch_number = (initial_batch_number or "INITIAL-BATCH").strip()
                batch_result = await db.execute(
                    select(Batch).where(Batch.item_id == item.id, Batch.batch_number == batch_number)
                )
                batch = batch_result.scalar_one_or_none()
                if not batch:
                    from datetime import datetime, timedelta
                    if initial_batch_expiry:
                        expiry_date = datetime.combine(initial_batch_expiry, datetime.min.time())
                    else:
                        expiry_date = datetime.now() + timedelta(days=3650)
                    batch = Batch(
                        item_id=item.id,
                        batch_number=batch_number,
                        expiry_date=expiry_date,
                        status="active"
                    )
                    db.add(batch)
                    await db.flush()
                batch_id = batch.id

                from app.services.stock_service import post_stock_ledger
                await post_stock_ledger(
                    db=db,
                    item_id=item.id,
                    warehouse_id=warehouse.id,
                    transaction_type="opening",
                    qty_in=Decimal(str(initial_quantity)),
                    rate=item.purchase_price or Decimal("0"),
                    bin_id=bin_id,
                    batch_id=batch_id,
                    uom_id=item.primary_uom_id,
                    created_by=current_user.id
                )
    except IntegrityError as exc:
        await db.rollback()
        raw = str(getattr(exc, "orig", exc))
        if "item_code" in raw:
            raise HTTPException(status_code=409, detail="Item code already exists. Please use a unique item code.") from exc
        if "name" in raw:
            raise HTTPException(status_code=409, detail="Item name already exists. Please use a unique item name.") from exc
        raise HTTPException(status_code=409, detail=f"Item could not be created because a referenced or unique value conflicts: {raw}") from exc
    except OperationalError as exc:
        await db.rollback()
        raw = str(getattr(exc, "orig", exc))
        if "item_master_kit_components" in raw:
            raise HTTPException(status_code=422, detail="Kit component table is missing. Run `alembic upgrade heads` from the backend, then try again.") from exc
        raise HTTPException(status_code=500, detail=f"Database error while creating item: {raw}") from exc
    except SQLAlchemyError as exc:
        await db.rollback()
        raw = str(getattr(exc, "orig", exc))
        raise HTTPException(status_code=500, detail=f"Database error while creating item: {raw}") from exc
    return {"id": item.id, "item_code": item.item_code, "readable_code": item.readable_code, "message": "Item created"}


@router.post("/items/preview-code")
async def preview_item_code(
    payload: dict,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    await ensure_item_category_code_schema(db)
    """Returns what auto-generated code WOULD be for the given category,
    without consuming a sequence number. Useful for UI preview.
    """
    from app.services.item_coding import preview_hierarchy_item_code
    try:
        return await preview_hierarchy_item_code(db, payload.get("category_id"))
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


# Wave 11A â€” bulk backfill endpoint for legacy items
@router.post("/items/backfill-codes")
async def backfill_item_codes(
    dry_run: bool = True,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_permission("masters", "update", "items")),
):
    from app.services.item_coding import backfill_codes
    return await backfill_codes(db, dry_run=dry_run)


@router.put("/items/{item_id}")
async def update_item(
    item_id: int,
    payload: ItemUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_permission("masters", "update", "items")),
):
    await ensure_feature_schema(db)
    await ensure_item_uom_category_schema(db)
    result = await db.execute(select(Item).where(Item.id == item_id))
    item = result.scalar_one_or_none()
    if not item:
        raise HTTPException(status_code=404, detail="Item not found")
    update_data = payload.model_dump(exclude_unset=True)

    brand_val = update_data.get("brand")
    if brand_val:
        from app.models.inventory_master import Brand
        brand_obj = None
        if str(brand_val).isdigit():
            brand_obj = (await db.execute(select(Brand).where(Brand.id == int(brand_val)))).scalar_one_or_none()
        if not brand_obj:
            brand_obj = (await db.execute(select(Brand).where(func.lower(Brand.code) == str(brand_val).lower()))).scalar_one_or_none()
        if brand_obj:
            update_data["brand"] = brand_obj.code

    kit_components_explicit = "kit_components" in payload.model_fields_set
    kit_components = update_data.pop("kit_components", None)
    update_data.pop("category_id", None)
    explicit_feature_update = "feature_ids" in payload.model_fields_set or "feature_id" in payload.model_fields_set
    incoming_feature_ids = update_data.pop("feature_ids", None) if "feature_ids" in update_data else None
    incoming_feature_id = update_data.get("feature_id") if "feature_id" in update_data else None

    effective_category_id = update_data.get("category_id", item.category_id)
    current_feature_ids = await _item_feature_ids(db, int(item.id))
    if not current_feature_ids and item.feature_id:
        current_feature_ids = [int(item.feature_id)]

    if explicit_feature_update:
        requested_feature_ids = (
            incoming_feature_ids
            if incoming_feature_ids is not None
            else ([incoming_feature_id] if incoming_feature_id is not None else [])
        )
        validated_feature_ids = await _validate_item_features(db, effective_category_id, requested_feature_ids)
    else:
        validated_feature_ids = list(current_feature_ids)
        if "category_id" in update_data and validated_feature_ids:
            rows = (await db.execute(select(Feature).where(Feature.id.in_(validated_feature_ids)))).scalars().all()
            by_id = {int(r.id): r for r in rows}
            validated_feature_ids = [
                fid for fid in validated_feature_ids
                if fid in by_id and by_id[fid].is_active and by_id[fid].category_id == effective_category_id
            ]

    update_data["feature_id"] = validated_feature_ids[0] if validated_feature_ids else None
    if "primary_uom_id" in update_data:
        await _normalize_item_uom_category(db, update_data)
    else:
        uom_validation_data = dict(update_data)
        uom_validation_data["primary_uom_id"] = item.primary_uom_id
        await _normalize_item_uom_category(db, uom_validation_data)

    min_q = update_data.get("min_order_qty")
    if min_q is None:
        min_q = item.min_order_qty
    max_q = update_data.get("max_order_qty")
    if max_q is None:
        max_q = item.max_order_qty

    if min_q is not None and max_q is not None and min_q > 0 and max_q > 0 and min_q >= max_q:
        raise HTTPException(status_code=422, detail="Min order qty must be less than max order qty")

    for k, v in update_data.items():
        setattr(item, k, v)
    if "name" in update_data:
        item.readable_code = await _item_readable_code(db, item.category_id, item.name)
    # Auto-set dosage_form for equipment if not explicitly provided
    if item.item_type == "equipment" and not item.dosage_form:
        item.dosage_form = "unit"
    await db.flush()
    await _replace_item_features(db, int(item.id), validated_feature_ids)
    if kit_components_explicit or "is_kit" in update_data:
        await _replace_item_kit_components(db, int(item.id), bool(item.is_kit), kit_components if kit_components_explicit else None, item.item_code)
    return {"success": True, "message": "Item updated"}


# ---- Item detail tab stubs (BUG-FE-021) ----
# ItemForm.jsx fires GETs at items/{id}/{stock,vendors,prices,packing,transactions}
# on tab change. Without these, every tab silently 404s and shows Empty. Provide
# minimal real-data stubs (or empty paginated envelopes) so the UI renders.

@router.get("/items/{item_id}/stock")
async def get_item_stock(
    item_id: int,
    page: int = Query(1, ge=1),
    page_size: int = Query(200, ge=1, le=1000),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    try:
        from app.models.stock import StockBalance  # type: ignore
    except Exception:
        return build_paginated_response([], 0, page, page_size)
    offset, limit = paginate_params(page, page_size)
    total = (await db.execute(
        select(func.count(StockBalance.id)).where(StockBalance.item_id == item_id)
    )).scalar() or 0
    rows = (await db.execute(
        select(StockBalance)
        .where(StockBalance.item_id == item_id)
        .order_by(StockBalance.id.desc())
        .offset(offset).limit(limit)
    )).scalars().all()
    items = []
    for sb in rows:
        items.append({
            "id": sb.id,
            "warehouse_id": getattr(sb, "warehouse_id", None),
            "warehouse_name": None,
            "location_name": None,
            "bin_code": getattr(sb, "bin_code", None) or getattr(sb, "bin_id", None),
            "batch_number": getattr(sb, "batch_number", None),
            "quantity": float(getattr(sb, "quantity", 0) or 0),
            "reserved_qty": float(getattr(sb, "reserved_qty", 0) or 0),
            "available_qty": float(getattr(sb, "available_qty", 0) or 0),
            "valuation_amount": float(getattr(sb, "valuation_amount", 0) or 0),
        })
    return build_paginated_response(items, total, page, page_size)


@router.get("/items/{item_id}/vendors")
async def get_item_vendors(
    item_id: int,
    page: int = Query(1, ge=1),
    page_size: int = Query(200, ge=1, le=1000),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    offset, limit = paginate_params(page, page_size)
    total = (await db.execute(
        select(func.count(VendorItem.id)).where(VendorItem.item_id == item_id)
    )).scalar() or 0
    rows = (await db.execute(
        select(VendorItem, Vendor.vendor_code, Vendor.name)
        .join(Vendor, VendorItem.vendor_id == Vendor.id, isouter=True)
        .where(VendorItem.item_id == item_id)
        .order_by(VendorItem.id.desc())
        .offset(offset).limit(limit)
    )).all()
    items = []
    for vi, vendor_code, vendor_name in rows:
        items.append({
            "id": vi.id,
            "vendor_id": vi.vendor_id,
            "vendor_code": vendor_code,
            "vendor_name": vendor_name,
            "lead_time_days": vi.lead_time_days,
            "last_price": float(vi.rate) if vi.rate is not None else None,
            "last_supplied_date": None,
            "is_preferred": vi.is_preferred,
        })
    return build_paginated_response(items, total, page, page_size)


@router.get("/items/{item_id}/prices")
async def get_item_prices(
    item_id: int,
    page: int = Query(1, ge=1),
    page_size: int = Query(200, ge=1, le=1000),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    offset, limit = paginate_params(page, page_size)
    total = (await db.execute(
        select(func.count(PriceListItem.id)).where(PriceListItem.item_id == item_id)
    )).scalar() or 0
    rows = (await db.execute(
        select(PriceListItem, PriceList.name, PriceList.type)
        .join(PriceList, PriceListItem.price_list_id == PriceList.id, isouter=True)
        .where(PriceListItem.item_id == item_id)
        .order_by(PriceListItem.id.desc())
        .offset(offset).limit(limit)
    )).all()
    items = []
    for pli, pl_name, pl_type in rows:
        items.append({
            "id": pli.id,
            "price_list_id": pli.price_list_id,
            "price_list_name": pl_name,
            "type": pl_type,
            "rate": float(pli.rate) if pli.rate is not None else None,
            "min_qty": float(pli.min_qty) if pli.min_qty is not None else None,
            "valid_from": pli.valid_from,
            "valid_to": pli.valid_to,
        })
    return build_paginated_response(items, total, page, page_size)




@router.get("/items/{item_id}/transactions")
async def get_item_transactions(
    item_id: int,
    page: int = Query(1, ge=1),
    page_size: int = Query(100, ge=1, le=500),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """BUG-FE-021: minimal transactions stub. Full implementation requires
    inventory/stock-movement tables â€” return empty list when those models
    are missing so the UI renders 'No data' instead of silently failing."""
    try:
        from app.models.stock import StockTransaction  # type: ignore
    except Exception:
        return build_paginated_response([], 0, page, page_size)
    offset, limit = paginate_params(page, page_size)
    total = (await db.execute(
        select(func.count(StockTransaction.id)).where(StockTransaction.item_id == item_id)
    )).scalar() or 0
    rows = (await db.execute(
        select(StockTransaction)
        .where(StockTransaction.item_id == item_id)
        .order_by(StockTransaction.id.desc())
        .offset(offset).limit(limit)
    )).scalars().all()
    items = []
    for t in rows:
        items.append({
            "id": t.id,
            "transaction_date": getattr(t, "transaction_date", None) or getattr(t, "created_at", None),
            "type": getattr(t, "transaction_type", None) or getattr(t, "type", None),
            "doc_number": getattr(t, "doc_number", None),
            "quantity": float(getattr(t, "quantity", 0) or 0),
            "warehouse_id": getattr(t, "warehouse_id", None),
        })
    return build_paginated_response(items, total, page, page_size)


@router.delete("/items/{item_id}")
async def deactivate_item(
    item_id: int,
    force: bool = Query(False),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_permission("masters", "delete", "items")),
):
    """BUG-FE-005: refuse deactivation if active stock balances or vendor_items
    reference this item â€” would orphan rows. Pass ?force=true to override (admins
    only, when they have already cleaned up dependents)."""
    result = await db.execute(select(Item).where(Item.id == item_id))
    item = result.scalar_one_or_none()
    if not item:
        raise HTTPException(status_code=404, detail="Item not found")

    # FK guard: count live references in stock_balance and vendor_items
    refs = []
    try:
        from app.models.stock import StockBalance  # type: ignore
        sb_count = (await db.execute(
            select(func.count(StockBalance.id)).where(
                StockBalance.item_id == item_id,
                (StockBalance.total_qty != 0) | (StockBalance.reserved_qty != 0),
            )
        )).scalar() or 0
        if sb_count:
            refs.append(f"{sb_count} active stock balance(s)")
    except Exception as exc:
        print(f"Error in deactivate_item stock check: {exc}")
        pass
    vi_count = (await db.execute(
        select(func.count(VendorItem.id)).where(VendorItem.item_id == item_id)
    )).scalar() or 0
    if vi_count:
        refs.append(f"{vi_count} vendor-item link(s)")

    if refs and not force:
        has_stock = any("stock balance" in r for r in refs)
        if has_stock:
            detail_msg = "Cannot deactivate this item because there is still active stock in the warehouse. Please ensure the stock quantity is 0 before deactivating."
        else:
            detail_msg = "Cannot deactivate this item because it is currently linked to active vendors."
        raise HTTPException(
            status_code=409,
            detail=detail_msg,
        )

    item.is_active = False
    await db.flush()
    return {"success": True, "message": "Item deactivated"}


@router.get("/price-lists")
async def list_price_lists(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    result = await db.execute(select(PriceList).where(PriceList.is_active == True))
    return [{"id": p.id, "name": p.name, "type": p.type, "currency": p.currency, "is_default": p.is_default} for p in result.scalars().all()]


@router.post("/price-lists", status_code=201)
async def create_price_list(
    payload: PriceListCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    pl = PriceList(**payload.model_dump())
    db.add(pl)
    await db.flush()
    return {"id": pl.id, "message": "Price list created"}


@router.post("/price-lists/items", status_code=201)
async def add_price_list_item(
    payload: PriceListItemCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    pli = PriceListItem(**payload.model_dump())
    db.add(pli)
    await db.flush()
    return {"id": pli.id, "message": "Price list item added"}


# ---- Price List Item CRUD scoped under price list (BUG-FE-177) ----
# Frontend expects /masters/price-lists/{id}/items (GET/POST/PUT/DELETE).

@router.get("/price-lists/{price_list_id}/items")
async def list_price_list_items(
    price_list_id: int,
    page: int = Query(1, ge=1),
    page_size: int = Query(500, ge=1, le=1000),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    # Confirm parent price list exists
    pl = (await db.execute(select(PriceList).where(PriceList.id == price_list_id))).scalar_one_or_none()
    if not pl:
        raise HTTPException(status_code=404, detail="Price list not found")
    offset, limit = paginate_params(page, page_size)
    total = (await db.execute(
        select(func.count(PriceListItem.id)).where(PriceListItem.price_list_id == price_list_id)
    )).scalar() or 0
    result = await db.execute(
        select(PriceListItem, Item.code, Item.name)
        .join(Item, PriceListItem.item_id == Item.id, isouter=True)
        .where(PriceListItem.price_list_id == price_list_id)
        .order_by(PriceListItem.id.desc())
        .offset(offset).limit(limit)
    )
    rows = result.all()
    items = []
    for pli, item_code, item_name in rows:
        items.append({
            "id": pli.id,
            "price_list_id": pli.price_list_id,
            "item_id": pli.item_id,
            "item_code": item_code,
            "item_name": item_name,
            "rate": float(pli.rate) if pli.rate is not None else None,
            "min_qty": float(pli.min_qty) if pli.min_qty is not None else None,
            "valid_from": pli.valid_from,
            "valid_to": pli.valid_to,
        })
    return build_paginated_response(items, total, page, page_size)


@router.post("/price-lists/{price_list_id}/items", status_code=201)
async def add_price_list_item_scoped(
    price_list_id: int,
    payload: dict,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    pl = (await db.execute(select(PriceList).where(PriceList.id == price_list_id))).scalar_one_or_none()
    if not pl:
        raise HTTPException(status_code=404, detail="Price list not found")
    data = dict(payload or {})
    data["price_list_id"] = price_list_id
    if "item_id" not in data or data["item_id"] in (None, ""):
        raise HTTPException(status_code=400, detail="item_id is required")
    if "rate" not in data or data["rate"] in (None, ""):
        raise HTTPException(status_code=400, detail="rate is required")
    # Filter to model columns
    allowed = {"price_list_id", "item_id", "rate", "min_qty", "valid_from", "valid_to"}
    clean = {k: v for k, v in data.items() if k in allowed}
    pli = PriceListItem(**clean)
    db.add(pli)
    await db.flush()
    return {"id": pli.id, "message": "Price list item added"}


@router.put("/price-lists/{price_list_id}/items/{item_id}")
async def update_price_list_item(
    price_list_id: int,
    item_id: int,
    payload: dict,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    result = await db.execute(
        select(PriceListItem).where(
            PriceListItem.id == item_id,
            PriceListItem.price_list_id == price_list_id,
        )
    )
    pli = result.scalar_one_or_none()
    if not pli:
        raise HTTPException(status_code=404, detail="Price list item not found")
    allowed = {"item_id", "rate", "min_qty", "valid_from", "valid_to"}
    for k, v in (payload or {}).items():
        if k in allowed:
            setattr(pli, k, v)
    await db.flush()
    return {"success": True, "message": "Price list item updated"}


@router.delete("/price-lists/{price_list_id}/items/{item_id}")
async def delete_price_list_item(
    price_list_id: int,
    item_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    result = await db.execute(
        select(PriceListItem).where(
            PriceListItem.id == item_id,
            PriceListItem.price_list_id == price_list_id,
        )
    )
    pli = result.scalar_one_or_none()
    if not pli:
        raise HTTPException(status_code=404, detail="Price list item not found")
    # Hard delete: price_list_items has no is_active column.
    await db.delete(pli)
    await db.flush()
    return {"success": True, "message": "Price list item removed"}

@router.get("/user-material-mapping/tree")
async def get_user_material_mapping_tree(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_permission("masters-user-material-mapping", "view", "masters-user-material-mapping")),
):
    await ensure_organization_structure_schema(db)
    await ensure_user_item_permission_schema(db)
    role_rows = (await db.execute(
        select(Role.id, Role.code, Role.name)
        .where(Role.is_active == True)
        .order_by(Role.name)
    )).all()
    category_rows = (await db.execute(
        select(ItemCategory.id, ItemCategory.parent_id, ItemCategory.code, ItemCategory.full_code, ItemCategory.name)
        .order_by(ItemCategory.full_code, ItemCategory.name)
    )).all()
    item_rows = (await db.execute(
        select(Item.id, Item.item_code, Item.name, Item.category_id)
        .where(Item.is_active == True)  # noqa: E712
        .order_by(Item.item_code, Item.name)
    )).all()
    existing_rows = (await db.execute(
        select(RoleItemPermission.role_id, RoleItemPermission.entity_type, RoleItemPermission.entity_id, RoleItemPermission.action)
        .order_by(RoleItemPermission.role_id)
    )).all()
    return {
        "projects": [],
        "positions": [],
        "roles": [{"id": r.id, "code": r.code, "name": r.name} for r in role_rows],
        "direct_roles": [],
        "users": [],
        "categories": [
            {"id": r.id, "parent_id": r.parent_id, "code": r.code, "full_code": r.full_code, "name": r.name}
            for r in category_rows
        ],
        "items": [{"id": r.id, "item_code": r.item_code, "name": r.name, "category_id": r.category_id} for r in item_rows],
        "existing": [
            {"role_id": r.role_id, "entity_type": r.entity_type, "entity_id": r.entity_id, "action": r.action}
            for r in existing_rows
        ],
    }


@router.get("/user-material-mappings")
async def list_user_material_mappings(
    page: int = Query(1, ge=1),
    page_size: int = Query(200, ge=1, le=1000),
    search: str = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_permission("masters-user-material-mapping", "view", "masters-user-material-mapping")),
):
    await ensure_organization_structure_schema(db)
    await ensure_user_item_permission_schema(db)
    offset, limit = paginate_params(page, page_size)
    category_alias = aliased(ItemCategory)
    item_alias = aliased(Item)
    q = (
        select(
            RoleItemPermission,
            Role.code.label("role_code"),
            Role.name.label("role_name"),
            category_alias.name.label("category_name"),
            category_alias.full_code.label("category_code"),
            item_alias.item_code,
            item_alias.name.label("item_name"),
        )
        .join(Role, RoleItemPermission.role_id == Role.id)
        .join(category_alias, (RoleItemPermission.entity_type == "item_category") & (RoleItemPermission.entity_id == category_alias.id), isouter=True)
        .join(item_alias, (RoleItemPermission.entity_type == "item") & (RoleItemPermission.entity_id == item_alias.id), isouter=True)
    )
    count_q = select(func.count(RoleItemPermission.id)).join(Role, RoleItemPermission.role_id == Role.id)
    if search:
        like = f"%{search}%"
        condition = or_(
            Role.name.ilike(like),
            Role.code.ilike(like),
            category_alias.name.ilike(like),
            category_alias.full_code.ilike(like),
            item_alias.item_code.ilike(like),
            item_alias.name.ilike(like),
            RoleItemPermission.action.ilike(like),
        )
        q = q.where(condition)
        count_q = (
            count_q
            .join(category_alias, (RoleItemPermission.entity_type == "item_category") & (RoleItemPermission.entity_id == category_alias.id), isouter=True)
            .join(item_alias, (RoleItemPermission.entity_type == "item") & (RoleItemPermission.entity_id == item_alias.id), isouter=True)
            .where(condition)
        )
    total = (await db.execute(count_q)).scalar() or 0
    rows = (await db.execute(q.order_by(RoleItemPermission.created_at.desc(), RoleItemPermission.id.desc()).offset(offset).limit(limit))).all()
    items = []
    for permission, role_code, role_name, category_name, category_code, item_code, item_name in rows:
        target_name = category_name if permission.entity_type == "item_category" else item_name
        target_code = category_code if permission.entity_type == "item_category" else item_code
        items.append({
            "id": permission.id,
            "role_id": permission.role_id,
            "role_code": role_code,
            "role_name": role_name,
            "entity_type": permission.entity_type,
            "entity_id": permission.entity_id,
            "target_code": target_code,
            "target_name": target_name,
            "action": permission.action,
            "created_at": permission.created_at,
        })
    return build_paginated_response(items, total, page, page_size)


@router.post("/user-material-mappings/bulk", status_code=201)
async def bulk_map_user_materials(
    payload: UserItemBulkMapCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_permission("masters-user-material-mapping", "update", "masters-user-material-mapping")),
):
    await ensure_organization_structure_schema(db)
    await ensure_user_item_permission_schema(db)
    role_ids = payload.role_ids
    category_ids = payload.category_ids
    item_ids = payload.item_ids
    valid_role_ids = {
        int(row[0])
        for row in (await db.execute(select(Role.id).where(Role.id.in_(role_ids), Role.is_active == True))).all()  # noqa: E712
    }
    valid_category_ids = set()
    if category_ids:
        valid_category_ids = {
            int(row[0])
            for row in (await db.execute(select(ItemCategory.id).where(ItemCategory.id.in_(category_ids)))).all()
        }
    valid_item_ids = set()
    if item_ids:
        valid_item_ids = {
            int(row[0])
            for row in (await db.execute(select(Item.id).where(Item.id.in_(item_ids), Item.is_active == True))).all()  # noqa: E712
        }
    missing_roles = [rid for rid in role_ids if rid not in valid_role_ids]
    missing_categories = [cid for cid in category_ids if cid not in valid_category_ids]
    missing_items = [iid for iid in item_ids if iid not in valid_item_ids]
    if missing_roles or missing_categories or missing_items:
        raise HTTPException(
            status_code=422,
            detail={
                "message": "Only active roles, valid categories, and active items can be mapped",
                "missing_role_ids": missing_roles,
                "missing_category_ids": missing_categories,
                "missing_item_ids": missing_items,
            },
        )
    if payload.replace_existing:
        await db.execute(
            delete(RoleItemPermission).where(
                RoleItemPermission.role_id.in_(role_ids),
                RoleItemPermission.action == payload.action,
            )
        )
    existing_rows = (await db.execute(
        select(RoleItemPermission.role_id, RoleItemPermission.entity_type, RoleItemPermission.entity_id).where(
            RoleItemPermission.role_id.in_(role_ids),
            RoleItemPermission.action == payload.action,
        )
    )).all()
    existing = {(int(rid), etype, int(eid) if eid is not None else None) for rid, etype, eid in existing_rows}
    targets = [("item_category", cid) for cid in category_ids] + [("item", iid) for iid in item_ids]
    created = 0
    skipped = 0
    for role_id in role_ids:
        for entity_type, entity_id in targets:
            key = (role_id, entity_type, entity_id)
            if key in existing:
                skipped += 1
                continue
            db.add(RoleItemPermission(role_id=role_id, entity_type=entity_type, entity_id=entity_id, action=payload.action))
            created += 1
    await db.flush()
    return {
        "success": True,
        "message": f"Mapped {created} role-material permission(s)",
        "created": created,
        "skipped_existing": skipped,
        "roles": len(role_ids),
        "categories": len(category_ids),
        "items": len(item_ids),
    }


async def _get_bom_detail(db: AsyncSession, bom_id: int):
    stmt = (
        select(BOM)
        .where(BOM.id == bom_id)
        .options(
            selectinload(BOM.project),
            selectinload(BOM.position),
            selectinload(BOM.components).selectinload(BOMComponent.item),
            selectinload(BOM.components).selectinload(BOMComponent.uom)
        )
    )
    res = await db.execute(stmt)
    return res.scalar_one_or_none()


def _enrich_bom_response(bom: BOM) -> dict:
    components_data = []
    for comp in bom.components:
        components_data.append({
            "id": comp.id,
            "bom_id": comp.bom_id,
            "item_id": comp.item_id,
            "qty": comp.qty,
            "uom_id": comp.uom_id,
            "item_name": comp.item.name if comp.item else None,
            "item_code": comp.item.item_code if comp.item else None,
            "uom_name": comp.uom.name if comp.uom else None,
        })
    
    return {
        "id": bom.id,
        "bom_code": bom.bom_code,
        "name": bom.name,
        "project_id": bom.project_id,
        "project_name": bom.project.name if bom.project else None,
        "position_id": bom.position_id,
        "position_name": bom.position.name if bom.position else None,
        "document_types": bom.document_types,
        "is_active": bom.is_active,
        "created_at": bom.created_at,
        "updated_at": bom.updated_at,
        "components": components_data
    }


@router.post("/boms", response_model=BOMResponse, status_code=201)
async def create_bom(
    payload: BOMCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    from app.services.number_series import generate_number
    # Generate unique BOM Code
    bom_code = await generate_number(db, "masters", "bom")
    
    # Create main BOM record
    bom = BOM(
        bom_code=bom_code,
        name=payload.name,
        project_id=payload.project_id,
        position_id=payload.position_id,
        document_types=payload.document_types,
        is_active=True,
        created_by=current_user.id,
        created_at=datetime.now(timezone.utc),
        updated_at=datetime.now(timezone.utc)
    )
    db.add(bom)
    await db.flush()  # Populates bom.id

    # Create associated BOM Components
    for comp in payload.components:
        bom_comp = BOMComponent(
            bom_id=bom.id,
            item_id=comp.item_id,
            qty=comp.qty,
            uom_id=comp.uom_id
        )
        db.add(bom_comp)

    await db.commit()
    
    # Fetch details for rich response
    new_bom = await _get_bom_detail(db, bom.id)
    return _enrich_bom_response(new_bom)


@router.get("/boms")
async def list_boms(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=1000),
    search: str = Query(None),
    project_id: int = Query(None),
    position_id: int = Query(None),
    is_active: bool = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    offset, limit = paginate_params(page, page_size)
    query = select(BOM)
    count_query = select(func.count(BOM.id))

    if project_id is not None:
        query = query.where(BOM.project_id == project_id)
        count_query = count_query.where(BOM.project_id == project_id)

    if position_id is not None:
        query = query.where(BOM.position_id == position_id)
        count_query = count_query.where(BOM.position_id == position_id)

    if is_active is not None:
        query = query.where(BOM.is_active == is_active)
        count_query = count_query.where(BOM.is_active == is_active)

    if search:
        query = apply_search_filter(query, BOM, search, ["bom_code", "name"])
        count_query = apply_search_filter(count_query, BOM, search, ["bom_code", "name"])

    total = (await db.execute(count_query)).scalar()
    
    result = await db.execute(
        query.options(
            selectinload(BOM.project),
            selectinload(BOM.position),
            selectinload(BOM.components).selectinload(BOMComponent.item),
            selectinload(BOM.components).selectinload(BOMComponent.uom)
        )
        .offset(offset).limit(limit)
        .order_by(BOM.id.desc())
    )
    boms = result.scalars().all()
    
    response_items = [_enrich_bom_response(b) for b in boms]
    return build_paginated_response(response_items, total, page, page_size)


@router.get("/boms/{bom_id}", response_model=BOMResponse)
async def get_bom(
    bom_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    bom = await _get_bom_detail(db, bom_id)
    if not bom:
        raise HTTPException(status_code=404, detail="BOM not found")
    return _enrich_bom_response(bom)


@router.put("/boms/{bom_id}", response_model=BOMResponse)
async def update_bom(
    bom_id: int,
    payload: BOMUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    bom = await _get_bom_detail(db, bom_id)
    if not bom:
        raise HTTPException(status_code=404, detail="BOM not found")

    if payload.name is not None:
        bom.name = payload.name
    if payload.project_id is not None or "project_id" in payload.model_fields_set:
        bom.project_id = payload.project_id
    if payload.position_id is not None or "position_id" in payload.model_fields_set:
        bom.position_id = payload.position_id
    if payload.document_types is not None:
        bom.document_types = payload.document_types
    if payload.is_active is not None:
        bom.is_active = payload.is_active

    if payload.components is not None:
        # Cascade deletes existing components and replaces with new ones
        bom.components.clear()
        for comp in payload.components:
            bom_comp = BOMComponent(
                bom_id=bom.id,
                item_id=comp.item_id,
                qty=comp.qty,
                uom_id=comp.uom_id
            )
            bom.components.append(bom_comp)

    bom.updated_at = datetime.now(timezone.utc)
    await db.commit()

    updated_bom = await _get_bom_detail(db, bom_id)
    return _enrich_bom_response(updated_bom)


@router.delete("/boms/{bom_id}")
async def delete_bom(
    bom_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    bom = await _get_bom_detail(db, bom_id)
    if not bom:
        raise HTTPException(status_code=404, detail="BOM not found")

    await db.delete(bom)
    await db.commit()
    return {"success": True, "message": "BOM deleted successfully"}


# --- masters_phase1 inventory items ---
async def _ensure_item_types_table(db: AsyncSession) -> None:
    """Create and backfill item_types for legacy DBs missing this table."""
    conn = await db.connection()
    await conn.run_sync(ItemType.__table__.create, checkfirst=True)

    existing_total = await db.scalar(select(func.count(ItemType.id)))
    if (existing_total or 0) > 0:
        return

    # Backfill distinct types from legacy items.item_type values.
    legacy_names = (
        await db.execute(
            select(Item.item_type).where(Item.item_type.is_not(None)).distinct()
        )
    ).scalars().all()
    seen = set()
    for raw in legacy_names:
        name = (raw or "").strip().lower()
        if not name or name in seen:
            continue
        seen.add(name)
        db.add(ItemType(name=name, is_active=True))
    if seen:
        await db.flush()

@router.get("/item-types")
async def list_item_types(
    search: Optional[str] = None,
    page: int = Query(1, ge=1), page_size: int = Query(50, ge=1, le=10000),
    db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user),
):
    try:
        await _ensure_item_types_table(db)
    except SQLAlchemyError as exc:
        raise HTTPException(status_code=500, detail="Failed to initialize item types master table") from exc
    q = select(ItemType).order_by(ItemType.name)
    if search:
        like = f"%{search}%"
        q = q.where(ItemType.name.ilike(like))
    count_q = q.order_by(None).with_only_columns(func.count(ItemType.id))
    total = await db.scalar(count_q)
    offset, limit = paginate_params(page, page_size)
    rows = (await db.execute(q.offset(offset).limit(limit))).scalars().all()
    return build_paginated_response(
        [
            {"id": it.id, "name": it.name,
             "description": it.description, "is_active": it.is_active}
            for it in rows
        ],
        total or 0, page, page_size,
    )


@router.post("/item-types", status_code=201)
async def create_item_type(
    payload: ItemTypeCreate,
    db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user),
):
    try:
        await _ensure_item_types_table(db)
    except SQLAlchemyError as exc:
        raise HTTPException(status_code=500, detail="Failed to initialize item types master table") from exc
    existing = await db.execute(
        select(ItemType).where(func.lower(ItemType.name) == payload.name.strip().lower())
    )
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=409, detail=f"Item type '{payload.name}' already exists")
    it = ItemType(name=payload.name.strip().lower(), description=payload.description, is_active=payload.is_active)
    db.add(it)
    await db.flush()
    return {"id": it.id, "message": "Item type created"}


@router.put("/item-types/{item_type_id}")
async def update_item_type(
    item_type_id: int,
    payload: ItemTypeCreate,
    db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user),
):
    try:
        await _ensure_item_types_table(db)
    except SQLAlchemyError as exc:
        raise HTTPException(status_code=500, detail="Failed to initialize item types master table") from exc
    result = await db.execute(select(ItemType).where(ItemType.id == item_type_id))
    it = result.scalar_one_or_none()
    if not it:
        raise HTTPException(status_code=404, detail="Item type not found")
    # Check for name collision (case-insensitive)
    dup = await db.execute(
        select(ItemType).where(
            func.lower(ItemType.name) == payload.name.strip().lower(),
            ItemType.id != item_type_id,
        )
    )
    if dup.scalar_one_or_none():
        raise HTTPException(status_code=409, detail=f"Item type '{payload.name}' already exists")
    old_name = it.name
    new_name = payload.name.strip().lower()
    it.name = new_name
    it.description = payload.description
    it.is_active = payload.is_active
    # If the name changed, update all items referencing the old name
    if old_name != new_name:
        await db.execute(sql_update(Item).where(Item.item_type == old_name).values(item_type=new_name))
    await db.flush()
    return {"success": True, "message": "Item type updated"}


@router.delete("/item-types/{item_type_id}")
async def delete_item_type(
    item_type_id: int,
    db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user),
):
    try:
        await _ensure_item_types_table(db)
    except SQLAlchemyError as exc:
        raise HTTPException(status_code=500, detail="Failed to initialize item types master table") from exc
    result = await db.execute(select(ItemType).where(ItemType.id == item_type_id))
    it = result.scalar_one_or_none()
    if not it:
        raise HTTPException(status_code=404, detail="Item type not found")
    # Check if items reference this type
    item_count = (await db.execute(
        select(func.count(Item.id)).where(Item.item_type == it.name)
    )).scalar() or 0
    if item_count > 0:
        raise HTTPException(
            status_code=409,
            detail=f"Cannot delete item type referenced by {item_count} item(s). Move items first.",
        )
    it.is_active = False
    await db.flush()
    return {"success": True, "message": "Item type deactivated"}


# --- Item Sub Classes CRUD ---

from app.models.inventory_master import ItemSubClass
from app.schemas.master import ItemSubClassCreate, ItemSubClassResponse
from sqlalchemy import or_

@router.get("/item-sub-classes")
async def list_item_sub_classes(
    search: Optional[str] = None,
    item_type_id: Optional[int] = None,
    is_active: Optional[bool] = None,
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=10000),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    q = select(ItemSubClass).options(selectinload(ItemSubClass.item_type)).order_by(ItemSubClass.name)
    if item_type_id is not None:
        q = q.where(ItemSubClass.item_type_id == item_type_id)
    if is_active is not None:
        q = q.where(ItemSubClass.is_active == is_active)
    if search:
        like = f"%{search}%"
        q = q.where(
            or_(
                ItemSubClass.name.ilike(like),
                ItemSubClass.code.ilike(like),
                ItemSubClass.description.ilike(like),
            )
        )
    count_q = q.order_by(None).with_only_columns(func.count(ItemSubClass.id))
    total = await db.scalar(count_q)
    offset, limit = paginate_params(page, page_size)
    rows = (await db.execute(q.offset(offset).limit(limit))).scalars().all()
    
    items = []
    for sc in rows:
        items.append({
            "id": sc.id,
            "item_type_id": sc.item_type_id,
            "item_type_name": sc.item_type.name if sc.item_type else None,
            "name": sc.name,
            "code": sc.code,
            "description": sc.description,
            "inventory": sc.inventory,
            "depreciation": sc.depreciation,
            "example": sc.example,
            "is_active": sc.is_active,
            "status": "active" if sc.is_active else "inactive",
        })
    return build_paginated_response(items, total or 0, page, page_size)


@router.post("/item-sub-classes", status_code=201)
async def create_item_sub_class(
    payload: ItemSubClassCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    parent = await db.get(ItemType, payload.item_type_id)
    if not parent:
        raise HTTPException(status_code=404, detail="Parent Item Class not found")
        
    existing = await db.execute(
        select(ItemSubClass).where(
            ItemSubClass.item_type_id == payload.item_type_id,
            func.lower(ItemSubClass.code) == payload.code.strip().lower()
        )
    )
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=409, detail=f"Sub class with code '{payload.code}' already exists under this parent class")

    sc = ItemSubClass(
        item_type_id=payload.item_type_id,
        name=payload.name.strip(),
        code=payload.code.strip().upper(),
        description=payload.description,
        inventory=payload.inventory,
        depreciation=payload.depreciation,
        example=payload.example,
        is_active=payload.is_active
    )
    db.add(sc)
    await db.flush()
    return {"id": sc.id, "message": "Item sub class created"}


@router.put("/item-sub-classes/{sub_class_id}")
async def update_item_sub_class(
    sub_class_id: int,
    payload: ItemSubClassCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    sc = await db.get(ItemSubClass, sub_class_id)
    if not sc:
        raise HTTPException(status_code=404, detail="Item sub class not found")
        
    parent = await db.get(ItemType, payload.item_type_id)
    if not parent:
        raise HTTPException(status_code=404, detail="Parent Item Class not found")

    dup = await db.execute(
        select(ItemSubClass).where(
            ItemSubClass.item_type_id == payload.item_type_id,
            func.lower(ItemSubClass.code) == payload.code.strip().lower(),
            ItemSubClass.id != sub_class_id
        )
    )
    if dup.scalar_one_or_none():
        raise HTTPException(status_code=409, detail=f"Sub class with code '{payload.code}' already exists under this parent class")

    sc.item_type_id = payload.item_type_id
    sc.name = payload.name.strip()
    sc.code = payload.code.strip().upper()
    sc.description = payload.description
    sc.inventory = payload.inventory
    sc.depreciation = payload.depreciation
    sc.example = payload.example
    sc.is_active = payload.is_active

    await db.flush()
    return {"success": True, "message": "Item sub class updated"}


@router.delete("/item-sub-classes/{sub_class_id}")
async def delete_item_sub_class(
    sub_class_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    sc = await db.get(ItemSubClass, sub_class_id)
    if not sc:
        raise HTTPException(status_code=404, detail="Item sub class not found")

    item_count = (await db.execute(
        select(func.count(Item.id)).where(Item.item_sub_class_id == sub_class_id)
    )).scalar() or 0
    if item_count > 0:
        raise HTTPException(
            status_code=409,
            detail=f"Cannot delete item sub class referenced by {item_count} item(s). Move items first.",
        )
        
    sc.is_active = False
    await db.flush()
    return {"success": True, "message": "Item sub class deactivated"}

@router.get("/features")
async def list_features(
    search: Optional[str] = None,
    category_id: Optional[int] = None,
    include_inactive: bool = Query(False),
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=500),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    await ensure_feature_schema(db)
    q = select(Feature).order_by(Feature.name)
    if category_id is not None:
        cat_ids = await _get_parent_category_ids(db, category_id)
        q = q.where(Feature.category_id.in_(cat_ids))
    if not include_inactive:
        q = q.where(Feature.is_active == True)  # noqa: E712
    if search:
        q = q.where(Feature.name.ilike(f"%{search}%"))
    count_q = q.order_by(None).with_only_columns(func.count(Feature.id))
    total = await db.scalar(count_q)
    offset, limit = paginate_params(page, page_size)
    rows = (await db.execute(q.offset(offset).limit(limit))).scalars().all()
    cat_ids = list({r.category_id for r in rows})
    category_map = {}
    if cat_ids:
        cats = (
            await db.execute(select(ItemCategory.id, ItemCategory.name).where(ItemCategory.id.in_(cat_ids)))
        ).all()
        category_map = {cid: cname for cid, cname in cats}
    return build_paginated_response(
        [
            {
                "id": f.id,
                "name": f.name,
                "category_id": f.category_id,
                "category_name": category_map.get(f.category_id),
                "is_active": f.is_active,
            }
            for f in rows
        ],
        total or 0,
        page,
        page_size,
    )


@router.post("/features", status_code=201)
async def create_feature(
    payload: FeatureCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    await ensure_feature_schema(db)
    category = (await db.execute(select(ItemCategory).where(ItemCategory.id == payload.category_id))).scalar_one_or_none()
    if not category:
        raise HTTPException(status_code=404, detail="Category not found")
    name = payload.name.strip()
    dup = await db.execute(
        select(Feature).where(
            Feature.category_id == payload.category_id,
            func.lower(func.trim(Feature.name)) == name.lower(),
        )
    )
    if dup.scalar_one_or_none():
        raise HTTPException(status_code=409, detail=f"Feature '{name}' already exists for this category")
    row = Feature(category_id=payload.category_id, name=name, is_active=payload.is_active)
    db.add(row)
    await db.flush()
    return {"id": row.id, "message": "Feature created"}


@router.put("/features/{feature_id}")
async def update_feature(
    feature_id: int,
    payload: FeatureCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    await ensure_feature_schema(db)
    row = (await db.execute(select(Feature).where(Feature.id == feature_id))).scalar_one_or_none()
    if not row:
        raise HTTPException(status_code=404, detail="Feature not found")
    category = (await db.execute(select(ItemCategory).where(ItemCategory.id == payload.category_id))).scalar_one_or_none()
    if not category:
        raise HTTPException(status_code=404, detail="Category not found")
    name = payload.name.strip()
    dup = await db.execute(
        select(Feature).where(
            Feature.category_id == payload.category_id,
            func.lower(func.trim(Feature.name)) == name.lower(),
            Feature.id != feature_id,
        )
    )
    if dup.scalar_one_or_none():
        raise HTTPException(status_code=409, detail=f"Feature '{name}' already exists for this category")
    row.category_id = payload.category_id
    row.name = name
    row.is_active = payload.is_active
    await db.flush()
    return {"id": row.id, "message": "Feature updated"}


@router.delete("/features/{feature_id}")
async def delete_feature(
    feature_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    await ensure_feature_schema(db)
    row = (await db.execute(select(Feature).where(Feature.id == feature_id))).scalar_one_or_none()
    if not row:
        raise HTTPException(status_code=404, detail="Feature not found")
    active_items = (await db.execute(
        select(func.count(func.distinct(Item.id)))
        .select_from(Item)
        .outerjoin(ItemFeature, ItemFeature.item_id == Item.id)
        .where(
            Item.is_active == True,  # noqa: E712
            or_(Item.feature_id == feature_id, ItemFeature.feature_id == feature_id),
        )
    )).scalar() or 0
    if active_items > 0:
        raise HTTPException(
            status_code=409,
            detail=f"Cannot deactivate feature referenced by {active_items} active item(s).",
        )
    row.is_active = False
    await db.flush()
    return {"success": True, "message": "Feature deactivated"}


class BrandPayload(BaseModel):
    code: str = Field(..., min_length=1, max_length=50)
    name: str = Field(..., min_length=1, max_length=255)
    manufacturer_id: Optional[int] = None
    description: Optional[str] = None
    is_active: bool = True


@router.get("/brands")
async def list_brands(
    search: Optional[str] = None,
    page: int = Query(1, ge=1), page_size: int = Query(50, ge=1, le=500),
    db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user),
):
    q = select(Brand).order_by(Brand.id.desc())
    if search:
        like = f"%{search}%"
        q = q.where((Brand.code.ilike(like)) | (Brand.name.ilike(like)))
    # BUG-FE-030: strip order_by from the count query — preserving it forces
    # Postgres to perform an unnecessary sort under the COUNT(*) wrap.
    count_q = q.order_by(None).with_only_columns(func.count(Brand.id))
    total = await db.scalar(count_q)
    offset, limit = paginate_params(page, page_size)
    rows = (await db.execute(q.offset(offset).limit(limit))).scalars().all()
    return build_paginated_response(
        [
            {"id": b.id, "code": b.code, "name": b.name,
             "manufacturer_id": b.manufacturer_id,
             "description": b.description, "is_active": b.is_active}
            for b in rows
        ],
        total or 0, page, page_size,
    )


@router.post("/brands", status_code=201)
async def create_brand(
    payload: BrandPayload,
    db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user),
):
    # BUG-FE-023: case-insensitive uniqueness so "ACME" and "acme" can't coexist
    code_val = (payload.code or "").strip()
    dup = await db.execute(
        select(Brand).where(func.lower(Brand.code) == code_val.lower())
    )
    if dup.scalar_one_or_none():
        raise HTTPException(409, f"Brand with code '{code_val}' already exists")
    # BUG-FE-024: case-insensitive trimmed name duplicate check so 'Dolo' and
    # 'Dolo ' can't coexist as separate brands.
    name_val = (payload.name or "").strip()
    name_dup = await db.execute(
        select(Brand).where(func.lower(func.trim(Brand.name)) == name_val.lower())
    )
    if name_dup.scalar_one_or_none():
        raise HTTPException(409, f"Brand with name '{name_val}' already exists")
    data = payload.model_dump()
    data["code"] = code_val.upper()
    data["name"] = name_val
    b = Brand(**data)
    db.add(b)
    await db.flush()
    return {"id": b.id, "message": "Brand created"}


@router.put("/brands/{brand_id}")
async def update_brand(
    brand_id: int, payload: BrandPayload,
    db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user),
):
    b = (await db.execute(select(Brand).where(Brand.id == brand_id))).scalar_one_or_none()
    if not b:
        raise HTTPException(404, "Brand not found")
    # BUG-FE-026: re-check duplicate code on PUT (case-insensitive)
    code_val = (payload.code or "").strip()
    if code_val:
        dup = await db.execute(
            select(Brand).where(
                func.lower(Brand.code) == code_val.lower(),
                Brand.id != brand_id,
            )
        )
        if dup.scalar_one_or_none():
            raise HTTPException(409, f"Brand with code '{code_val}' already exists")
    # BUG-FE-024: re-check duplicate name on PUT
    name_val = (payload.name or "").strip()
    if name_val:
        name_dup = await db.execute(
            select(Brand).where(
                func.lower(func.trim(Brand.name)) == name_val.lower(),
                Brand.id != brand_id,
            )
        )
        if name_dup.scalar_one_or_none():
            raise HTTPException(409, f"Brand with name '{name_val}' already exists")
    data = payload.model_dump()
    if code_val:
        data["code"] = code_val.upper()
    if name_val:
        data["name"] = name_val
    for k, v in data.items():
        setattr(b, k, v)
    await db.flush()
    return {"id": b.id, "message": "Brand updated"}


@router.delete("/brands/{brand_id}")
async def delete_brand(
    brand_id: int,
    db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user),
):
    b = (await db.execute(select(Brand).where(Brand.id == brand_id))).scalar_one_or_none()
    if not b:
        raise HTTPException(404, "Brand not found")
    b.is_active = False
    await db.flush()
    return {"message": "Brand deactivated"}


class AttributePayload(BaseModel):
    category_id: Optional[int] = None
    code: str = Field(..., min_length=1, max_length=50)
    name: str = Field(..., min_length=1, max_length=255)
    # BUG-FE-033: previously `str` with manual validation. Pydantic Literal
    # rejects unknown values at parse time with proper 422 details.
    data_type: Literal["text", "number", "boolean", "enum"] = "text"
    uom_category_id: Optional[int] = None
    uom_id: Optional[int] = None
    allowed_values: Optional[str] = None
    is_required: bool = False
    sort_order: int = 0
    is_active: bool = True


class AttributeCategoryMappingPayload(BaseModel):
    attribute_id: int
    category_ids: List[int] = Field(..., min_length=1)


async def _normalize_uom_links(
    db: AsyncSession,
    uom_category_id: Optional[int],
    uom_id: Optional[int],
) -> tuple[Optional[int], Optional[int]]:
    if uom_category_id:
        category = (
            await db.execute(
                select(UOMCategory).where(
                    UOMCategory.id == uom_category_id,
                    UOMCategory.is_active == True,  # noqa: E712
                )
            )
        ).scalar_one_or_none()
        if not category:
            raise HTTPException(422, "UOM category does not exist or is inactive")

    if not uom_id:
        return uom_category_id, None

    uom = (
        await db.execute(
            select(UOM).where(
                UOM.id == uom_id,
                UOM.is_active == True,  # noqa: E712
            )
        )
    ).scalar_one_or_none()
    if not uom:
        raise HTTPException(422, "UOM does not exist or is inactive")
    if uom_category_id and uom.category_id != uom_category_id:
        raise HTTPException(422, "Selected UOM does not belong to the selected UOM category")
    return uom_category_id or uom.category_id, uom_id


def _attr_row(a: ItemAttribute) -> dict:
    return {
        "id": a.id, "category_id": a.category_id,
        "code": a.code, "name": a.name,
        "data_type": a.data_type, "uom_category_id": a.uom_category_id,
        "uom_id": a.uom_id,
        "allowed_values": a.allowed_values,
        "is_required": a.is_required, "sort_order": a.sort_order,
        "is_active": a.is_active,
    }


async def _get_descendant_category_ids(db: AsyncSession, category_ids: list[int]) -> list[int]:
    """Return selected item category IDs plus every active descendant at any depth."""
    ordered = list(dict.fromkeys(category_ids or []))
    if not ordered:
        return []

    rows = (
        await db.execute(
            select(ItemCategory.id, ItemCategory.parent_id).where(ItemCategory.is_active == True)  # noqa: E712
        )
    ).all()
    children_by_parent: dict[int, list[int]] = {}
    active_ids = set()
    for cid, parent_id in rows:
        active_ids.add(cid)
        if parent_id is not None:
            children_by_parent.setdefault(parent_id, []).append(cid)

    missing = [cid for cid in ordered if cid not in active_ids]
    if missing:
        raise HTTPException(422, f"Unknown or inactive category id(s): {', '.join(map(str, missing))}")

    result = []
    seen = set()
    stack = list(reversed(ordered))
    while stack:
        cid = stack.pop()
        if cid in seen:
            continue
        seen.add(cid)
        result.append(cid)
        for child_id in reversed(children_by_parent.get(cid, [])):
            stack.append(child_id)
    return result


async def _clone_attribute_to_descendants(db: AsyncSession, source: ItemAttribute) -> tuple[list[int], list[int], list[int]]:
    if not source.category_id:
        return [], [], []
    category_ids = await _get_descendant_category_ids(db, [source.category_id])
    mapped, reactivated, skipped = [], [], []
    for category_id in category_ids:
        if category_id == source.category_id:
            continue
        existing = (
            await db.execute(
                select(ItemAttribute).where(
                    ItemAttribute.category_id == category_id,
                    func.lower(func.trim(ItemAttribute.code)) == source.code.strip().lower(),
                )
            )
        ).scalar_one_or_none()
        if existing:
            existing.name = source.name
            existing.data_type = source.data_type
            existing.uom_category_id = source.uom_category_id
            existing.uom_id = source.uom_id
            existing.allowed_values = source.allowed_values
            existing.is_required = source.is_required
            existing.sort_order = source.sort_order
            if existing.is_active is False:
                existing.is_active = True
                reactivated.append(existing.id)
            else:
                skipped.append(existing.id)
            continue
        clone = ItemAttribute(
            category_id=category_id,
            code=source.code,
            name=source.name,
            data_type=source.data_type,
            uom_category_id=source.uom_category_id,
            uom_id=source.uom_id,
            allowed_values=source.allowed_values,
            is_required=source.is_required,
            sort_order=source.sort_order,
            is_active=True,
        )
        db.add(clone)
        await db.flush()
        mapped.append(clone.id)
    return mapped, reactivated, skipped

@router.get("/item-attributes")
async def list_attributes(
    category_id: Optional[int] = None,
    db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user),
):
    await ensure_item_attribute_uom_schema(db)
    q = select(ItemAttribute)
    if category_id is not None:
        cat_ids = await _get_parent_category_ids(db, category_id)
        q = q.where(ItemAttribute.category_id.in_(cat_ids))
    q = q.order_by(ItemAttribute.sort_order, ItemAttribute.id)
    rows = (await db.execute(q)).scalars().all()
    if category_id is not None:
        priority = {cid: idx for idx, cid in enumerate(await _get_parent_category_ids(db, category_id))}
        rows = sorted(rows, key=lambda a: (priority.get(a.category_id, 999), a.sort_order or 0, a.id))
        nearest_by_code = {}
        for attr in rows:
            code_key = (attr.code or "").strip().lower()
            nearest_by_code.setdefault(code_key, attr)
        rows = list(nearest_by_code.values())
    return [_attr_row(a) for a in rows]


@router.post("/item-attributes", status_code=201)
async def create_attribute(
    payload: AttributePayload,
    db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user),
):
    await ensure_item_attribute_uom_schema(db)
    if payload.data_type not in ("text", "number", "boolean", "enum"):
        raise HTTPException(422, "data_type must be text, number, boolean, or enum")
    data = payload.model_dump()
    data["uom_category_id"], data["uom_id"] = await _normalize_uom_links(
        db, data.get("uom_category_id"), data.get("uom_id")
    )
    a = ItemAttribute(**data)
    db.add(a)
    try:
        await db.flush()
    except Exception as e:
        raise HTTPException(
            409,
            f"Attribute code '{payload.code}' already exists for this category",
        ) from e
    mapped, reactivated, skipped = await _clone_attribute_to_descendants(db, a)
    await db.flush()
    return {
        "id": a.id,
        "message": "Attribute created",
        "descendant_mapped": len(mapped),
        "descendant_reactivated": len(reactivated),
        "descendant_updated": len(skipped),
    }


@router.put("/item-attributes/{attr_id}")
async def update_attribute(
    attr_id: int, payload: AttributePayload,
    db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user),
):
    await ensure_item_attribute_uom_schema(db)
    a = (await db.execute(select(ItemAttribute).where(ItemAttribute.id == attr_id))).scalar_one_or_none()
    if not a:
        raise HTTPException(404, "Attribute not found")
    if payload.data_type not in ("text", "number", "boolean", "enum"):
        raise HTTPException(422, "data_type must be text, number, boolean, or enum")
    data = payload.model_dump()
    # BUG-FE-034: when data_type changes, scrub fields that no longer apply so
    # we don't carry stale allowed_values on a redefined attribute.
    if data.get("data_type") != "enum":
        data["allowed_values"] = None
    data["uom_category_id"], data["uom_id"] = await _normalize_uom_links(
        db, data.get("uom_category_id"), data.get("uom_id")
    )
    for k, v in data.items():
        setattr(a, k, v)
    mapped, reactivated, skipped = await _clone_attribute_to_descendants(db, a)
    await db.flush()
    return {
        "id": a.id,
        "message": "Attribute updated",
        "descendant_mapped": len(mapped),
        "descendant_reactivated": len(reactivated),
        "descendant_updated": len(skipped),
    }


@router.post("/item-attribute-category-mappings", status_code=201)
async def map_attribute_to_categories(
    payload: AttributeCategoryMappingPayload,
    db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user),
):
    await ensure_item_attribute_uom_schema(db)
    source = (
        await db.execute(select(ItemAttribute).where(ItemAttribute.id == payload.attribute_id))
    ).scalar_one_or_none()
    if not source:
        raise HTTPException(404, "Attribute not found")

    category_ids = await _get_descendant_category_ids(db, list(dict.fromkeys(payload.category_ids or [])))

    mapped = []
    reactivated = []
    skipped = []
    for category_id in category_ids:
        existing = (
            await db.execute(
                select(ItemAttribute).where(
                    ItemAttribute.category_id == category_id,
                    func.lower(func.trim(ItemAttribute.code)) == source.code.strip().lower(),
                )
            )
        ).scalar_one_or_none()
        if existing:
            if existing.is_active is False:
                existing.is_active = True
                reactivated.append(existing.id)
            else:
                skipped.append(existing.id)
            continue
        clone = ItemAttribute(
            category_id=category_id,
            code=source.code,
            name=source.name,
            data_type=source.data_type,
            uom_category_id=source.uom_category_id,
            uom_id=source.uom_id,
            allowed_values=source.allowed_values,
            is_required=source.is_required,
            sort_order=source.sort_order,
            is_active=True,
        )
        db.add(clone)
        await db.flush()
        mapped.append(clone.id)

    await db.flush()
    return {
        "message": "Attribute category mapping saved",
        "mapped": len(mapped),
        "reactivated": len(reactivated),
        "skipped": len(skipped),
        "mapped_ids": mapped,
        "reactivated_ids": reactivated,
        "skipped_ids": skipped,
    }


@router.delete("/item-attributes/{attr_id}")
async def delete_attribute(
    attr_id: int,
    db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user),
):
    await ensure_item_attribute_uom_schema(db)
    a = (await db.execute(select(ItemAttribute).where(ItemAttribute.id == attr_id))).scalar_one_or_none()
    if not a:
        raise HTTPException(404, "Attribute not found")
    target_attrs = [a]
    if a.category_id:
        descendant_ids = await _get_descendant_category_ids(db, [a.category_id])
        child_attrs = (
            await db.execute(
                select(ItemAttribute).where(
                    ItemAttribute.category_id.in_(descendant_ids),
                    func.lower(func.trim(ItemAttribute.code)) == a.code.strip().lower(),
                    ItemAttribute.id != a.id,
                )
            )
        ).scalars().all()
        target_attrs.extend(child_attrs)
    for attr in target_attrs:
        attr.is_active = False
    # BUG-FE-032: cascade — drop dependent per-item values so they don't dangle
    # against an inactive attribute (where Items.jsx would otherwise still show
    # them in the form).
    values = (
        await db.execute(
            select(ItemAttributeValue).where(ItemAttributeValue.attribute_id.in_([attr.id for attr in target_attrs]))
        )
    ).scalars().all()
    deleted_values = 0
    for v in values:
        await db.delete(v)
        deleted_values += 1
    await db.flush()
    return {"message": "Attribute deactivated", "attributes_deactivated": len(target_attrs), "values_deleted": deleted_values}

class AttributeValuePayload(BaseModel):
    attribute_id: int
    value: Optional[str] = None
    uom_category_id: Optional[int] = None
    uom_id: Optional[int] = None


@router.get("/items/{item_id}/attribute-values")
async def list_item_attribute_values(
    item_id: int,
    db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user),
):
    await ensure_item_attribute_uom_schema(db)
    rows = (
        await db.execute(select(ItemAttributeValue).where(ItemAttributeValue.item_id == item_id))
    ).scalars().all()
    return [
        {
            "id": v.id,
            "attribute_id": v.attribute_id,
            "value": v.value,
            "uom_category_id": v.uom_category_id,
            "uom_id": v.uom_id,
        }
        for v in rows
    ]


@router.put("/items/{item_id}/attribute-values")
async def replace_item_attribute_values(
    item_id: int, payload: List[AttributeValuePayload],
    db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user),
):
    await ensure_item_attribute_uom_schema(db)
    # BUG-FE-040: lock the parent item row to serialize concurrent writers so
    # delete-then-insert can't race and double-insert / drop values.
    item = (
        await db.execute(
            select(Item).where(Item.id == item_id).with_for_update()
        )
    ).scalar_one_or_none()
    if not item:
        raise HTTPException(404, "Item not found")

    # BUG-FE-016: pre-fetch attribute definitions once and validate enum values
    # against allowed_values. Fail fast before deleting existing rows.
    attr_ids = list({row.attribute_id for row in payload})
    attrs_by_id: dict = {}
    if attr_ids:
        rows = (
            await db.execute(
                select(ItemAttribute).where(ItemAttribute.id.in_(attr_ids))
            )
        ).scalars().all()
        attrs_by_id = {a.id: a for a in rows}
    normalized_rows = []
    for row in payload:
        a = attrs_by_id.get(row.attribute_id)
        if not a:
            raise HTTPException(422, f"Unknown attribute_id {row.attribute_id}")
        if a.data_type == "enum" and row.value not in (None, ""):
            allowed_raw = a.allowed_values or ""
            allowed = [s.strip() for s in allowed_raw.split(",") if s.strip()]
            if allowed and row.value not in allowed:
                raise HTTPException(
                    422,
                    f"Value '{row.value}' for attribute '{a.code}' is not in allowed_values "
                    f"({', '.join(allowed)})",
                )
        if a.data_type == "boolean" and row.value not in (None, "", "true", "false"):
            raise HTTPException(
                422,
                f"Value for boolean attribute '{a.code}' must be 'true' or 'false'",
            )
        if a.data_type == "number" and row.value not in (None, ""):
            try:
                float(row.value)
            except (TypeError, ValueError):
                raise HTTPException(
                    422, f"Value for number attribute '{a.code}' must be numeric"
                )
        uom_category_id = row.uom_category_id or a.uom_category_id
        uom_id = row.uom_id or a.uom_id
        uom_category_id, uom_id = await _normalize_uom_links(db, uom_category_id, uom_id)
        normalized_rows.append((row, uom_category_id, uom_id))

    existing = (
        await db.execute(select(ItemAttributeValue).where(ItemAttributeValue.item_id == item_id))
    ).scalars().all()
    for v in existing:
        await db.delete(v)
    for row, uom_category_id, uom_id in normalized_rows:
        db.add(
            ItemAttributeValue(
                item_id=item_id, attribute_id=row.attribute_id,
                value=row.value, uom_category_id=uom_category_id, uom_id=uom_id,
            )
        )
    await db.flush()
    return {"message": "Attribute values saved", "count": len(payload)}


class SpecCategoryPayload(BaseModel):
    code: str = Field(..., min_length=1, max_length=30)
    name: str = Field(..., min_length=1, max_length=100)
    description: Optional[str] = None
    base_uom_id: Optional[int] = None
    sort_order: int = 0
    is_active: bool = True


class SpecPayload(BaseModel):
    category_id: int
    code: str = Field(..., min_length=1, max_length=50)
    name: str = Field(..., min_length=1, max_length=100)
    data_type: Literal["text", "number", "boolean", "enum", "range"] = "text"
    uom_id: Optional[int] = None
    uom_category_id: Optional[int] = None
    allowed_values: Optional[str] = None
    is_required: bool = False
    sort_order: int = 0
    is_active: bool = True


class ItemSpecPayload(BaseModel):
    item_category_ids: List[int] = Field(..., min_length=1)
    spec_id: int
    default_value: Optional[str] = None
    uom_id: Optional[int] = None
    is_required: bool = False
    sort_order: int = 0


class ItemSpecUpdatePayload(BaseModel):
    default_value: Optional[str] = None
    uom_id: Optional[int] = None
    is_required: bool = False
    sort_order: int = 0
    is_active: bool = True


class ItemSpecValuePayload(BaseModel):
    spec_id: int
    value: Optional[str] = None
    min_value: Optional[str] = None
    max_value: Optional[str] = None
    uom_id: Optional[int] = None



def _clean_code(value: str) -> str:
    return (value or "").strip().upper()


async def _ensure_uom_exists(db: AsyncSession, uom_id: Optional[int]) -> None:
    if not uom_id:
        return
    exists = (
        await db.execute(select(UOM.id).where(UOM.id == uom_id, UOM.is_active == True))  # noqa: E712
    ).scalar_one_or_none()
    if not exists:
        raise HTTPException(422, "UOM does not exist or is inactive")


def _spec_category_row(row: SpecCategory, uom_map: dict[int, UOM] | None = None) -> dict:
    uom = (uom_map or {}).get(row.base_uom_id)
    return {
        "id": row.id,
        "code": row.code,
        "name": row.name,
        "description": row.description,
        "base_uom_id": row.base_uom_id,
        "base_uom_name": uom.name if uom else None,
        "base_uom_abbreviation": uom.abbreviation if uom else None,
        "sort_order": row.sort_order,
        "is_active": row.is_active,
    }


def _spec_row(row: Spec, category_map: dict[int, SpecCategory] | None = None) -> dict:
    category = (category_map or {}).get(row.category_id)
    return {
        "id": row.id,
        "category_id": row.category_id,
        "category_code": category.code if category else None,
        "category_name": category.name if category else None,
        "code": row.code,
        "name": row.name,
        "data_type": row.data_type,
        "uom_id": row.uom_id,
        "uom_category_id": row.uom_category_id,
        "allowed_values": row.allowed_values,
        "is_required": row.is_required,
        "sort_order": row.sort_order,
        "is_active": row.is_active,
    }


@router.get("/spec-categories")
async def list_spec_categories(
    include_inactive: bool = Query(False),
    search: Optional[str] = None,
    db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user),
):
    await ensure_specs_schema(db)
    q = select(SpecCategory).order_by(SpecCategory.sort_order, SpecCategory.name)
    if not include_inactive:
        q = q.where(SpecCategory.is_active == True)  # noqa: E712
    if search:
        like = f"%{search}%"
        q = q.where((SpecCategory.code.ilike(like)) | (SpecCategory.name.ilike(like)))
    rows = (await db.execute(q)).scalars().all()
    uom_ids = [r.base_uom_id for r in rows if r.base_uom_id]
    uom_map = {}
    if uom_ids:
        uoms = (await db.execute(select(UOM).where(UOM.id.in_(uom_ids)))).scalars().all()
        uom_map = {u.id: u for u in uoms}
    return [_spec_category_row(r, uom_map) for r in rows]


@router.post("/spec-categories", status_code=201)
async def create_spec_category(
    payload: SpecCategoryPayload,
    db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user),
):
    await ensure_specs_schema(db)
    await _ensure_uom_exists(db, payload.base_uom_id)
    code = _clean_code(payload.code)
    dup = await db.execute(select(SpecCategory).where(func.lower(SpecCategory.code) == code.lower()))
    if dup.scalar_one_or_none():
        raise HTTPException(409, f"Spec category '{code}' already exists")
    row = SpecCategory(
        code=code,
        name=payload.name.strip(),
        description=payload.description,
        base_uom_id=payload.base_uom_id,
        sort_order=payload.sort_order,
        is_active=payload.is_active,
    )
    db.add(row)
    await db.flush()
    return {"id": row.id, "message": "Spec category created"}


@router.put("/spec-categories/{category_id}")
async def update_spec_category(
    category_id: int, payload: SpecCategoryPayload,
    db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user),
):
    await ensure_specs_schema(db)
    await _ensure_uom_exists(db, payload.base_uom_id)
    row = (await db.execute(select(SpecCategory).where(SpecCategory.id == category_id))).scalar_one_or_none()
    if not row:
        raise HTTPException(404, "Spec category not found")
    code = _clean_code(payload.code)
    dup = await db.execute(
        select(SpecCategory).where(func.lower(SpecCategory.code) == code.lower(), SpecCategory.id != category_id)
    )
    if dup.scalar_one_or_none():
        raise HTTPException(409, f"Spec category '{code}' already exists")
    row.code = code
    row.name = payload.name.strip()
    row.description = payload.description
    row.base_uom_id = payload.base_uom_id
    row.sort_order = payload.sort_order
    row.is_active = payload.is_active
    await db.flush()
    return {"id": row.id, "message": "Spec category updated"}


@router.delete("/spec-categories/{category_id}")
async def delete_spec_category(
    category_id: int,
    db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user),
):
    await ensure_specs_schema(db)
    row = (await db.execute(select(SpecCategory).where(SpecCategory.id == category_id))).scalar_one_or_none()
    if not row:
        raise HTTPException(404, "Spec category not found")
    row.is_active = False
    await db.flush()
    return {"message": "Spec category deactivated"}


@router.get("/specs")
async def list_specs(
    category_id: Optional[int] = None,
    include_inactive: bool = Query(False),
    search: Optional[str] = None,
    db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user),
):
    await ensure_specs_schema(db)
    q = select(Spec).order_by(Spec.sort_order, Spec.name)
    if category_id:
        q = q.where(Spec.category_id == category_id)
    if not include_inactive:
        q = q.where(Spec.is_active == True)  # noqa: E712
    if search:
        like = f"%{search}%"
        q = q.where((Spec.code.ilike(like)) | (Spec.name.ilike(like)))
    rows = (await db.execute(q)).scalars().all()
    cat_ids = [r.category_id for r in rows]
    category_map = {}
    if cat_ids:
        cats = (await db.execute(select(SpecCategory).where(SpecCategory.id.in_(cat_ids)))).scalars().all()
        category_map = {c.id: c for c in cats}
    return [_spec_row(r, category_map) for r in rows]


@router.post("/specs", status_code=201)
async def create_spec(
    payload: SpecPayload,
    db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user),
):
    await ensure_specs_schema(db)
    category = (await db.execute(select(SpecCategory).where(SpecCategory.id == payload.category_id))).scalar_one_or_none()
    if not category:
        raise HTTPException(404, "Spec category not found")
    uom_category_id, uom_id = await _normalize_uom_links(db, payload.uom_category_id, payload.uom_id)
    code = _clean_code(payload.code)
    dup = await db.execute(select(Spec).where(func.lower(Spec.code) == code.lower()))
    if dup.scalar_one_or_none():
        raise HTTPException(409, f"Spec '{code}' already exists")
    row = Spec(
        category_id=payload.category_id,
        code=code,
        name=payload.name.strip(),
        data_type=payload.data_type,
        uom_id=uom_id,
        uom_category_id=uom_category_id,
        allowed_values=payload.allowed_values if payload.data_type == "enum" else None,
        is_required=payload.is_required,
        sort_order=payload.sort_order,
        is_active=payload.is_active,
    )
    db.add(row)
    await db.flush()
    return {"id": row.id, "message": "Spec created"}


@router.put("/specs/{spec_id}")
async def update_spec(
    spec_id: int, payload: SpecPayload,
    db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user),
):
    await ensure_specs_schema(db)
    row = (await db.execute(select(Spec).where(Spec.id == spec_id))).scalar_one_or_none()
    if not row:
        raise HTTPException(404, "Spec not found")
    category = (await db.execute(select(SpecCategory).where(SpecCategory.id == payload.category_id))).scalar_one_or_none()
    if not category:
        raise HTTPException(404, "Spec category not found")
    uom_category_id, uom_id = await _normalize_uom_links(db, payload.uom_category_id, payload.uom_id)
    code = _clean_code(payload.code)
    dup = await db.execute(select(Spec).where(func.lower(Spec.code) == code.lower(), Spec.id != spec_id))
    if dup.scalar_one_or_none():
        raise HTTPException(409, f"Spec '{code}' already exists")
    row.category_id = payload.category_id
    row.code = code
    row.name = payload.name.strip()
    row.data_type = payload.data_type
    row.uom_id = uom_id
    row.uom_category_id = uom_category_id
    row.allowed_values = payload.allowed_values if payload.data_type == "enum" else None
    row.is_required = payload.is_required
    row.sort_order = payload.sort_order
    row.is_active = payload.is_active
    await db.flush()
    return {"id": row.id, "message": "Spec updated"}


@router.delete("/specs/{spec_id}")
async def delete_spec(
    spec_id: int,
    db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user),
):
    await ensure_specs_schema(db)
    row = (await db.execute(select(Spec).where(Spec.id == spec_id))).scalar_one_or_none()
    if not row:
        raise HTTPException(404, "Spec not found")
    row.is_active = False
    await db.flush()
    return {"message": "Spec deactivated"}

@router.get("/item-specs")
async def list_item_specs(
    item_category_id: Optional[int] = None,
    include_inactive: bool = Query(False),
    db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user),
):
    await ensure_specs_schema(db)
    q = select(ItemSpec, ItemCategory, Spec).join(ItemCategory, ItemCategory.id == ItemSpec.item_category_id).join(Spec, Spec.id == ItemSpec.spec_id)
    if item_category_id:
        cat_ids = await _get_parent_category_ids(db, item_category_id)
        q = q.where(ItemSpec.item_category_id.in_(cat_ids))
    if not include_inactive:
        q = q.where(ItemSpec.is_active == True)  # noqa: E712
    q = q.order_by(ItemCategory.name, ItemSpec.sort_order, Spec.name)
    rows = (await db.execute(q)).all()
    if item_category_id:
        priority = {cid: idx for idx, cid in enumerate(await _get_parent_category_ids(db, item_category_id))}
        rows = sorted(rows, key=lambda r: (priority.get(r[0].item_category_id, 999), r[0].sort_order or 0, r[2].name))
        nearest_by_spec = {}
        for mapping, cat, spec in rows:
            nearest_by_spec.setdefault(mapping.spec_id, (mapping, cat, spec))
        rows = list(nearest_by_spec.values())
    return [
        {
            "id": m.id,
            "item_category_id": m.item_category_id,
            "item_category_code": cat.code,
            "item_category_name": cat.name,
            "spec_id": m.spec_id,
            "spec_code": spec.code,
            "spec_name": spec.name,
            "spec_data_type": spec.data_type,
            "spec_allowed_values": spec.allowed_values,
            "spec_uom_category_id": spec.uom_category_id,
            "spec_uom_id": spec.uom_id,
            "default_value": m.default_value,
            "uom_id": m.uom_id,
            "is_required": m.is_required,
            "sort_order": m.sort_order,
            "is_active": m.is_active,
        }
        for m, cat, spec in rows
    ]


@router.post("/item-specs", status_code=201)
async def create_item_specs(
    payload: ItemSpecPayload,
    db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user),
):
    await ensure_specs_schema(db)
    spec = (await db.execute(select(Spec).where(Spec.id == payload.spec_id))).scalar_one_or_none()
    if not spec:
        raise HTTPException(404, "Spec not found")
    await _ensure_uom_exists(db, payload.uom_id)
    category_ids = await _get_descendant_category_ids(db, list(dict.fromkeys(payload.item_category_ids or [])))
    mapped, reactivated, skipped = [], [], []
    for category_id in category_ids:
        existing = (
            await db.execute(
                select(ItemSpec).where(ItemSpec.item_category_id == category_id, ItemSpec.spec_id == payload.spec_id)
            )
        ).scalar_one_or_none()
        if existing:
            existing.default_value = payload.default_value
            existing.uom_id = payload.uom_id
            existing.is_required = payload.is_required
            existing.sort_order = payload.sort_order
            if existing.is_active is False:
                existing.is_active = True
                reactivated.append(existing.id)
            else:
                skipped.append(existing.id)
            continue
        row = ItemSpec(
            item_category_id=category_id,
            spec_id=payload.spec_id,
            default_value=payload.default_value,
            uom_id=payload.uom_id,
            is_required=payload.is_required,
            sort_order=payload.sort_order,
            is_active=True,
        )
        db.add(row)
        await db.flush()
        mapped.append(row.id)
    await db.flush()
    return {"message": "Item spec mapping saved", "mapped": len(mapped), "reactivated": len(reactivated), "skipped": len(skipped)}


@router.put("/item-specs/{mapping_id}")
async def update_item_spec(
    mapping_id: int, payload: ItemSpecUpdatePayload,
    db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user),
):
    await ensure_specs_schema(db)
    await _ensure_uom_exists(db, payload.uom_id)
    row = (await db.execute(select(ItemSpec).where(ItemSpec.id == mapping_id))).scalar_one_or_none()
    if not row:
        raise HTTPException(404, "Item spec mapping not found")
    row.default_value = payload.default_value
    row.uom_id = payload.uom_id
    row.is_required = payload.is_required
    row.sort_order = payload.sort_order
    row.is_active = payload.is_active
    if row.item_category_id:
        category_ids = await _get_descendant_category_ids(db, [row.item_category_id])
        child_rows = (
            await db.execute(
                select(ItemSpec).where(
                    ItemSpec.item_category_id.in_(category_ids),
                    ItemSpec.spec_id == row.spec_id,
                    ItemSpec.id != row.id,
                )
            )
        ).scalars().all()
        for child in child_rows:
            child.default_value = payload.default_value
            child.uom_id = payload.uom_id
            child.is_required = payload.is_required
            child.sort_order = payload.sort_order
            child.is_active = payload.is_active
    await db.flush()
    return {"id": row.id, "message": "Item spec mapping updated", "descendants_updated": len(child_rows) if row.item_category_id else 0}


@router.delete("/item-specs/{mapping_id}")
async def delete_item_spec(
    mapping_id: int,
    db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user),
):
    await ensure_specs_schema(db)
    row = (await db.execute(select(ItemSpec).where(ItemSpec.id == mapping_id))).scalar_one_or_none()
    if not row:
        raise HTTPException(404, "Item spec mapping not found")
    target_rows = [row]
    if row.item_category_id:
        category_ids = await _get_descendant_category_ids(db, [row.item_category_id])
        child_rows = (
            await db.execute(
                select(ItemSpec).where(
                    ItemSpec.item_category_id.in_(category_ids),
                    ItemSpec.spec_id == row.spec_id,
                    ItemSpec.id != row.id,
                )
            )
        ).scalars().all()
        target_rows.extend(child_rows)
    for target in target_rows:
        target.is_active = False
    await db.flush()
    return {"message": "Item spec mapping deactivated", "mappings_deactivated": len(target_rows)}


@router.get("/items/{item_id}/spec-values")
async def list_item_spec_values(
    item_id: int,
    db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user),
):
    await ensure_specs_schema(db)
    rows = (await db.execute(select(ItemSpecValue).where(ItemSpecValue.item_id == item_id))).scalars().all()
    return [
        {"id": r.id, "spec_id": r.spec_id, "value": r.value, "min_value": r.min_value, "max_value": r.max_value, "uom_id": r.uom_id}
        for r in rows
    ]


@router.put("/items/{item_id}/spec-values")
async def replace_item_spec_values(
    item_id: int, payload: List[ItemSpecValuePayload],
    db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user),
):
    await ensure_specs_schema(db)
    item = (await db.execute(select(Item).where(Item.id == item_id).with_for_update())).scalar_one_or_none()
    if not item:
        raise HTTPException(404, "Item not found")
    spec_ids = list({row.spec_id for row in payload})
    specs = {}
    if spec_ids:
        spec_rows = (await db.execute(select(Spec).where(Spec.id.in_(spec_ids)))).scalars().all()
        specs = {s.id: s for s in spec_rows}
    for row in payload:
        spec = specs.get(row.spec_id)
        if not spec:
            raise HTTPException(422, f"Unknown spec_id {row.spec_id}")
        if spec.data_type == "number" and row.value not in (None, ""):
            try:
                float(row.value)
            except (TypeError, ValueError):
                raise HTTPException(422, f"Value for spec '{spec.code}' must be numeric")
        if spec.data_type == "range":
            for field_name, field_value in (("min_value", row.min_value), ("max_value", row.max_value)):
                if field_value not in (None, ""):
                    try:
                        float(field_value)
                    except (TypeError, ValueError):
                        raise HTTPException(422, f"{field_name} for spec '{spec.code}' must be numeric")
        await _ensure_uom_exists(db, row.uom_id)
    existing = (await db.execute(select(ItemSpecValue).where(ItemSpecValue.item_id == item_id))).scalars().all()
    for row in existing:
        await db.delete(row)
    for row in payload:
        db.add(ItemSpecValue(item_id=item_id, spec_id=row.spec_id, value=row.value, min_value=row.min_value, max_value=row.max_value, uom_id=row.uom_id))
    await db.flush()
    return {"message": "Spec values saved", "count": len(payload)}


# ==================== modularized reports endpoints ====================
from typing import Optional
from datetime import date
from app.services.report_service import (
    stock_summary_report, stock_detail_report, stock_movement_report,
    low_stock_report, expiry_report, stock_valuation_report, dead_stock_report,
    abc_classification_report, fifo_cost_tracking_report, inventory_turnover_report
)

def _parse_date(s: Optional[str]):
    if not s:
        return None
    try:
        return date.fromisoformat(s)
    except Exception:
        return None

def _paginate_list(rows, page: int, page_size: int):
    total = len(rows)
    start = (page - 1) * page_size
    end = start + page_size
    return {
        "items": rows[start:end],
        "total": total,
        "page": page,
        "page_size": page_size,
    }


@router.get("/reports")
async def reports_inventory_dispatch(
    report_type: str = Query("stock_summary"),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100000),  # BUG-FIN-103/106: lift export cap
    warehouse_id: Optional[int] = Query(None),
    category_id: Optional[int] = Query(None),
    item_id: Optional[int] = Query(None),
    days: Optional[int] = Query(None),
    days_ahead: Optional[int] = Query(None),
    date_from: Optional[str] = Query(None),
    date_to: Optional[str] = Query(None),
    group_by_warehouse: bool = Query(False, description="Per-warehouse breakdown (BUG-FIN-107)"),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Inventory reports dispatcher.

    BUG-FIN-095: previously returned an empty stub.
    """
    df = _parse_date(date_from)
    dt = _parse_date(date_to)
    if report_type == "stock_summary":
        rows = await stock_summary_report(db, warehouse_id, category_id, group_by_warehouse=group_by_warehouse)
    elif report_type == "stock_detail":
        rows = await stock_detail_report(db, item_id, warehouse_id)
    elif report_type == "stock_movement":
        rows = await stock_movement_report(db, item_id, warehouse_id, df, dt)
    elif report_type == "low_stock":
        rows = await low_stock_report(db, warehouse_id)
    elif report_type == "expiry":
        rows = await expiry_report(db, days_ahead or 90, warehouse_id)
    elif report_type == "valuation":
        rows = await stock_valuation_report(db, warehouse_id)
    elif report_type == "dead_stock":
        rows = await dead_stock_report(db, days or 90, warehouse_id)
    elif report_type == "abc_classification":
        rows = await abc_classification_report(db)
    elif report_type == "fifo_cost_tracking":
        rows = await fifo_cost_tracking_report(db, item_id, warehouse_id)
    elif report_type == "turnover":
        rows = await inventory_turnover_report(db, df, dt, warehouse_id)
    else:
        rows = await stock_summary_report(db, warehouse_id, category_id)
    rows = list(rows or [])
    out = _paginate_list(rows, page, page_size)
    out["report_type"] = report_type
    return out

@router.get("/inventory/stock-summary")
async def rpt_stock_summary(
    warehouse_id: int = Query(None),
    category_id: int = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    return await stock_summary_report(db, warehouse_id, category_id)


@router.get("/inventory/stock-detail")
async def rpt_stock_detail(
    item_id: int = Query(None),
    warehouse_id: int = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    return await stock_detail_report(db, item_id, warehouse_id)


@router.get("/inventory/stock-movement")
async def rpt_stock_movement(
    item_id: int = Query(None),
    warehouse_id: int = Query(None),
    date_from: Optional[date] = Query(None),
    date_to: Optional[date] = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    return await stock_movement_report(db, item_id, warehouse_id, date_from, date_to)


@router.get("/inventory/low-stock")
async def rpt_low_stock(
    warehouse_id: int = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    return await low_stock_report(db, warehouse_id)



@router.get("/inventory/expiry")
async def rpt_expiry(
    days_ahead: int = Query(90),
    warehouse_id: int = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    return await expiry_report(db, days_ahead, warehouse_id)


@router.get("/inventory/valuation")
async def rpt_valuation(
    warehouse_id: int = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    return await stock_valuation_report(db, warehouse_id)


@router.get("/inventory/dead-stock")
async def rpt_dead_stock(
    days: int = Query(90),
    warehouse_id: int = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    return await dead_stock_report(db, days, warehouse_id)


@router.get("/inventory/batch-status")
async def rpt_batch_status(
    item_id: int = Query(None),
    warehouse_id: int = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Batch-wise stock status."""
    return await stock_detail_report(db, item_id, warehouse_id)


@router.get("/inventory/warehouse-wise")
async def rpt_warehouse_wise(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Stock summary per warehouse."""
    from sqlalchemy import select, func
    from app.models.stock import StockBalance
    from app.models.warehouse import Warehouse
    result = await db.execute(
        select(
            Warehouse.id, Warehouse.code, Warehouse.name,
            func.count(func.distinct(StockBalance.item_id)).label("item_count"),
            func.sum(StockBalance.total_qty).label("total_qty"),
            func.sum(StockBalance.stock_value).label("total_value"),
        )
        .join(StockBalance, StockBalance.warehouse_id == Warehouse.id)
        .group_by(Warehouse.id)
        .order_by(Warehouse.name)
    )
    return [dict(row._mapping) for row in result.all()]


@router.get("/inventory/category-wise")
async def rpt_category_wise(
    warehouse_id: int = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Stock summary per item category."""
    from sqlalchemy import select, func
    from app.models.stock import StockBalance
    from app.models.master import Item, ItemCategory
    query = (
        select(
            ItemCategory.id, ItemCategory.name,
            func.count(func.distinct(Item.id)).label("item_count"),
            func.sum(StockBalance.total_qty).label("total_qty"),
            func.sum(StockBalance.stock_value).label("total_value"),
        )
        .join(Item, Item.category_id == ItemCategory.id)
        .join(StockBalance, StockBalance.item_id == Item.id)
        .group_by(ItemCategory.id, ItemCategory.name)
    )
    if warehouse_id:
        query = query.where(StockBalance.warehouse_id == warehouse_id)
    result = await db.execute(query)
    return [dict(row._mapping) for row in result.all()]


@router.get("/inventory/abc-classification")
async def rpt_abc_classification(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """ABC classification report - items grouped by purchase value."""
    return await abc_classification_report(db)


@router.get("/inventory/fifo-cost-tracking")
async def rpt_fifo_cost_tracking(
    item_id: int = Query(None),
    warehouse_id: int = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """FIFO cost lot tracking report - stock ledger entries ordered by received date."""
    return await fifo_cost_tracking_report(db, item_id, warehouse_id)


@router.get("/inventory/turnover")
async def rpt_inventory_turnover(
    start_date: Optional[date] = Query(None),
    end_date: Optional[date] = Query(None),
    warehouse_id: int = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Inventory turnover report - consumption / average stock for a date range."""
    return await inventory_turnover_report(db, start_date, end_date, warehouse_id)


