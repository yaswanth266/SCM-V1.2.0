from decimal import Decimal
from datetime import datetime, timezone, date
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select, func, and_
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload
from app.database import get_db
from app.models.user import User
from app.models.issue import VehicleIssue, VehicleIssueItem
from app.models.warehouse import Warehouse, SerialNumber, WarehouseConfig
from app.models.master import Item as ItemModel, UOM, UOMConversion as _UC
from app.models.stock import StockBalance
from app.models.indent import Indent, IndentItem
from app.schemas.warehouse import (
    VehicleIssueCreate, VehicleIssueUpdate, VehicleIssueResponse,
)
from app.services.number_series import generate_number
from app.services.stock_service import reserve_stock, release_reservation, _get_or_create_balance, post_vehicle_stock_ledger
from app.utils.dependencies import get_current_user, require_key, require_permission
from app.utils.helpers import paginate_params, build_paginated_response, apply_search_filter
from app.api.v1.warehouse import validate_material_issue_items_flow, clean_serial_numbers

router = APIRouter()


@router.post("", status_code=201, dependencies=[Depends(require_key("warehouse-material-issues"))])
async def create_vehicle_issue(
    payload: VehicleIssueCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_permission(
        "warehouse-material-issues", "create", "warehouse-material-issues"
    )),
):
    """Create a new vehicle issue. Auto-generates issue_number."""
    if not payload.items:
        raise HTTPException(status_code=422, detail="At least one item is required")

    # Resolve central warehouse
    wh_row = await db.execute(select(Warehouse).where(Warehouse.id == payload.warehouse_id))
    wh = wh_row.scalar_one_or_none()
    if not wh:
        raise HTTPException(status_code=404, detail="Source warehouse not found")

    cfg_row = await db.execute(select(WarehouseConfig.is_central).where(WarehouseConfig.warehouse_id == payload.warehouse_id))
    is_central = cfg_row.scalar()
    if is_central is None:
        is_central = wh.parent_id is None

    if not is_central:
        for it in payload.items:
            it.batch_id = None
            it.bin_id = None

    await validate_material_issue_items_flow(db, payload.warehouse_id, payload.items, is_central)

    # Expiry validation
    from app.models.warehouse import Batch as _Batch
    batch_ids = [i.batch_id for i in payload.items if i.batch_id]
    batch_rows_list = []
    if batch_ids:
        br = await db.execute(select(_Batch).where(_Batch.id.in_(batch_ids)))
        batch_rows_list = br.scalars().all()
        today = date.today()
        for b in batch_rows_list:
            exp = b.expiry_date
            if exp is not None and hasattr(exp, "date"):
                exp = exp.date()
            if exp is not None and exp <= today:
                raise HTTPException(
                    status_code=400,
                    detail=f"Batch {b.batch_number} expired/expires today ({b.expiry_date}) — cannot issue."
                )

    # Validate batch mapping
    _batch_map = {b.id: b for b in batch_rows_list}
    for it in payload.items:
        if it.batch_id and it.batch_id in _batch_map:
            b = _batch_map[it.batch_id]
            if getattr(b, "warehouse_id", None) and b.warehouse_id != payload.warehouse_id:
                raise HTTPException(
                    status_code=400,
                    detail=f"Batch {b.batch_number} belongs to warehouse {b.warehouse_id}, not {payload.warehouse_id}"
                )

    # Determine template_id / template_name
    tmpl_id = getattr(payload, "template_id", None)
    tmpl_name = getattr(payload, "template_name", None)
    tmpl_type = getattr(payload, "template_type", None)

    if not tmpl_id and payload.indent_id:
        ind_r = await db.execute(select(Indent).where(Indent.id == payload.indent_id))
        ind_obj = ind_r.scalar_one_or_none()
        if ind_obj:
            tmpl_id = getattr(ind_obj, "template_id", None)
            tmpl_name = getattr(ind_obj, "template_name", None) or getattr(ind_obj, "template_type", None)
            tmpl_type = getattr(ind_obj, "template_type", None)

    # ─── STRICT DUPLICATE TEMPLATE ISSUE VALIDATION FOR VEHICLE ──────────────
    if tmpl_id or tmpl_name:
        dup_q = select(VehicleIssue).where(
            VehicleIssue.vehicle_code == payload.vehicle_code,
            VehicleIssue.vehicle_number == payload.vehicle_number,
            VehicleIssue.status != "cancelled",
        )
        if tmpl_id:
            dup_q = dup_q.where(VehicleIssue.template_id == tmpl_id)
        elif tmpl_name:
            dup_q = dup_q.where(VehicleIssue.template_name == tmpl_name)

        dup_res = await db.execute(dup_q)
        if dup_res.scalar_one_or_none():
            display_name = tmpl_name or f"Template #{tmpl_id}"
            raise HTTPException(
                status_code=400,
                detail=f"Template '{display_name}' has already been issued to vehicle '{payload.vehicle_code} ({payload.vehicle_number})'! Duplicate template issues to the same vehicle are strictly prohibited."
            )

    # Generate issue number
    issue_number = await generate_number(db, "warehouse", "vehicle_issue")

    vi = VehicleIssue(
        issue_number=issue_number,
        indent_id=payload.indent_id,
        warehouse_id=payload.warehouse_id,
        vehicle_code=payload.vehicle_code,
        vehicle_number=payload.vehicle_number,
        issue_date=payload.issue_date,
        department=payload.department,
        issued_to=payload.issued_to,
        status="draft",
        remarks=payload.remarks,
        issued_by=current_user.id,
        project_id=payload.project_id,
        template_id=tmpl_id,
        template_name=tmpl_name,
        template_type=tmpl_type or "dp_project",
    )
    db.add(vi)
    await db.flush()

    for item in payload.items:
        amount = item.qty * item.rate
        cleaned_sns = await clean_serial_numbers(db, item.item_id, item.serial_numbers)
        vii = VehicleIssueItem(
            vehicle_issue_id=vi.id,
            item_id=item.item_id,
            batch_id=item.batch_id,
            qty=item.qty,
            uom_id=item.uom_id,
            bin_id=item.bin_id,
            rate=item.rate,
            amount=amount,
            serial_numbers=cleaned_sns,
            batch_number_text=item.batch_number_text,
            bin_code_text=item.bin_code_text,
        )
        db.add(vii)

    await db.flush()
    return {"id": vi.id, "issue_number": issue_number, "message": "Vehicle issue created successfully"}


@router.get("", dependencies=[Depends(require_key("warehouse-material-issues", "indent-material-acknowledgement", "indent-acknowledgement"))])
async def list_vehicle_issues(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    search: str = Query(None),
    status: str = Query(None),
    warehouse_id: int = Query(None),
    employee_code: str = Query(None),
    assigned_to_me: bool = Query(False),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """List vehicle issues with pagination and search."""
    offset, limit = paginate_params(page, page_size)
    query = select(VehicleIssue).options(
        selectinload(VehicleIssue.warehouse),
        selectinload(VehicleIssue.issued_to_user).selectinload(User.employee),
        selectinload(VehicleIssue.issued_by_user),
        selectinload(VehicleIssue.indent).selectinload(Indent.raiser).selectinload(User.employee),
        selectinload(VehicleIssue.project),
        selectinload(VehicleIssue.items).selectinload(VehicleIssueItem.item),
        selectinload(VehicleIssue.items).selectinload(VehicleIssueItem.uom),
    )
    count_query = select(func.count(VehicleIssue.id))

    if status:
        query = query.where(VehicleIssue.status == status)
        count_query = count_query.where(VehicleIssue.status == status)
    if warehouse_id:
        query = query.where(VehicleIssue.warehouse_id == warehouse_id)
        count_query = count_query.where(VehicleIssue.warehouse_id == warehouse_id)

    if assigned_to_me:
        from sqlalchemy import or_
        from app.models.user import User as UserModel
        from app.models.indent import Indent as IndentModel
        from app.models.master import Employee as EmployeeModel
        
        my_filter = or_(
            VehicleIssue.issued_to == current_user.id,
            VehicleIssue.indent.has(IndentModel.raised_by == current_user.id),
        )
        curr_emp_code = current_user.employee_code or (current_user.employee.employee_code if current_user.employee else None)
        if curr_emp_code:
            emp_clean = curr_emp_code.strip()
            my_filter = or_(
                my_filter,
                VehicleIssue.issued_to_user.has(UserModel.employee_code.ilike(f"%{emp_clean}%")),
                VehicleIssue.issued_to_user.has(UserModel.employee.has(EmployeeModel.employee_code.ilike(f"%{emp_clean}%"))),
                VehicleIssue.indent.has(IndentModel.raiser.has(UserModel.employee_code.ilike(f"%{emp_clean}%"))),
                VehicleIssue.indent.has(IndentModel.raiser.has(UserModel.employee.has(EmployeeModel.employee_code.ilike(f"%{emp_clean}%"))))
            )
        query = query.where(my_filter)
        count_query = count_query.where(my_filter)

    if employee_code:
        from sqlalchemy import or_
        from app.models.user import User as UserModel
        from app.models.indent import Indent as IndentModel
        from app.models.master import Employee as EmployeeModel
        emp_clean = employee_code.strip()
        emp_filter = or_(
            VehicleIssue.issued_to_user.has(UserModel.employee_code.ilike(f"%{emp_clean}%")),
            VehicleIssue.issued_to_user.has(UserModel.employee.has(EmployeeModel.employee_code.ilike(f"%{emp_clean}%"))),
            VehicleIssue.indent.has(IndentModel.raiser.has(UserModel.employee_code.ilike(f"%{emp_clean}%"))),
            VehicleIssue.indent.has(IndentModel.raiser.has(UserModel.employee.has(EmployeeModel.employee_code.ilike(f"%{emp_clean}%"))))
        )
        query = query.where(emp_filter)
        count_query = count_query.where(emp_filter)

    query = apply_search_filter(query, VehicleIssue, search, ["issue_number", "vehicle_code", "vehicle_number", "remarks"])
    count_query = apply_search_filter(count_query, VehicleIssue, search, ["issue_number", "vehicle_code", "vehicle_number", "remarks"])

    total = (await db.execute(count_query)).scalar()
    result = await db.execute(query.offset(offset).limit(limit).order_by(VehicleIssue.id.desc()))
    issues = result.scalars().all()

    data = []
    for vi in issues:
        r_name = None
        r_emp_code = None

        if vi.issued_to_user:
            r_name = f"{vi.issued_to_user.first_name} {vi.issued_to_user.last_name or ''}".strip()
            r_emp_code = getattr(vi.issued_to_user, "employee_code", None)
            if not r_emp_code and vi.issued_to_user.employee:
                r_emp_code = vi.issued_to_user.employee.employee_code

        if not r_name and vi.indent and vi.indent.raiser:
            r = vi.indent.raiser
            r_name = f"{r.first_name} {r.last_name or ''}".strip()
            r_emp_code = getattr(r, "employee_code", None)
            if not r_emp_code and r.employee:
                r_emp_code = r.employee.employee_code

        created_by_name = f"{vi.issued_by_user.first_name} {vi.issued_by_user.last_name or ''}".strip() if vi.issued_by_user else None

        row = {
            "id": vi.id,
            "issue_number": vi.issue_number,
            "indent_id": vi.indent_id,
            "warehouse_id": vi.warehouse_id,
            "warehouse_name": vi.warehouse.name if vi.warehouse else None,
            "vehicle_code": vi.vehicle_code,
            "vehicle_number": vi.vehicle_number,
            "issue_date": vi.issue_date,
            "department": vi.department,
            "issued_to": vi.issued_to,
            "issued_to_name": f"{vi.issued_to_user.first_name} {vi.issued_to_user.last_name or ''}".strip() if vi.issued_to_user else None,
            "raised_by_name": r_name,
            "raised_by_emp_code": r_emp_code,
            "created_by_name": created_by_name,
            "status": vi.status,
            "remarks": vi.remarks,
            "issued_by": vi.issued_by,
            "project_id": vi.project_id,
            "project_name": vi.project.name if vi.project else None,
            "created_at": vi.created_at,
            "items": [
                {
                    "id": item.id,
                    "item_id": item.item_id,
                    "item_name": item.item.name if item.item else None,
                    "item_code": item.item.item_code if item.item else None,
                    "uom_name": item.uom.name if item.uom else None,
                    "qty": float(item.qty or 0),
                    "uom_id": item.uom_id,
                    "rate": float(item.rate or 0),
                    "amount": float(item.amount or 0),
                    "has_serial": bool(item.item.has_serial) if item.item else False,
                    "has_batch": bool(item.item.has_batch) if item.item else False,
                    "item_type": item.item.item_type if item.item else None,
                    "serial_numbers": item.serial_numbers,
                    "batch_number_text": item.batch_number_text,
                    "bin_code_text": item.bin_code_text,
                }
                for item in vi.items
            ]
        }
        data.append(row)

    return build_paginated_response(data, total, page, page_size)


@router.get("/{issue_id}", response_model=VehicleIssueResponse, dependencies=[Depends(require_key("warehouse-material-issues", "indent-material-acknowledgement", "indent-acknowledgement"))])
async def get_vehicle_issue(
    issue_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Get vehicle issue details with items."""
    result = await db.execute(
        select(VehicleIssue)
        .options(
            selectinload(VehicleIssue.items).selectinload(VehicleIssueItem.item),
            selectinload(VehicleIssue.items).selectinload(VehicleIssueItem.uom),
            selectinload(VehicleIssue.items).selectinload(VehicleIssueItem.batch),
            selectinload(VehicleIssue.warehouse),
            selectinload(VehicleIssue.issued_to_user),
            selectinload(VehicleIssue.project),
        )
        .where(VehicleIssue.id == issue_id)
    )
    vi = result.scalar_one_or_none()
    if not vi:
        raise HTTPException(status_code=404, detail="Vehicle issue not found")

    response = VehicleIssueResponse.model_validate(vi).model_dump()
    response["warehouse_name"] = vi.warehouse.name if vi.warehouse else None
    response["project_name"] = vi.project.name if vi.project else None
    response["issued_to_name"] = (
        f"{vi.issued_to_user.first_name} {vi.issued_to_user.last_name or ''}".strip()
    ) if vi.issued_to_user else None

    if vi.indent_id:
        from app.models.master import Position as PositionModel
        ind_res = await db.execute(
            select(Indent)
            .options(
                selectinload(Indent.position),
                selectinload(Indent.raiser).selectinload(User.employee)
            )
            .where(Indent.id == vi.indent_id)
        )
        indent_row = ind_res.scalar_one_or_none()
        if indent_row:
            response["indent_number"] = indent_row.indent_number
            if indent_row.raiser:
                r = indent_row.raiser
                response["raised_by_name"] = f"{r.first_name} {r.last_name or ''}".strip()
                response["raised_by_emp_code"] = getattr(r, "employee_code", None) or (r.employee.employee_code if r.employee else None)
            else:
                response["raised_by_emp_code"] = getattr(indent_row, "raised_by_emp_code", None) or getattr(indent_row, "employee_code", None)
                response["raised_by_name"] = getattr(indent_row, "raised_by_name", None) or getattr(indent_row, "created_by_name", None)
            
            if indent_row.position:
                response["position_name"] = indent_row.position.name
            if not response.get("department"):
                response["department"] = indent_row.department

    if vi.issued_to_user:
        if not response.get("department"):
            response["department"] = vi.issued_to_user.department
        if not response.get("position_name") and getattr(vi.issued_to_user, "designation", None):
            response["position_name"] = vi.issued_to_user.designation

    if vi.issued_by:
        usr_res = await db.execute(select(User).where(User.id == vi.issued_by))
        usr = usr_res.scalar_one_or_none()
        if usr:
            issuer_name = f"{usr.first_name} {usr.last_name or ''}".strip()
            response["issued_by_name"] = issuer_name
            response["created_by_name"] = issuer_name
            response["created_by_emp_code"] = getattr(usr, "employee_code", None)

    for i, item in enumerate(vi.items):
        response["items"][i]["item_name"] = item.item.name if item.item else None
        response["items"][i]["item_code"] = item.item.item_code if item.item else None
        response["items"][i]["item_type"] = item.item.item_type if item.item else None
        response["items"][i]["uom_name"] = item.uom.name if item.uom else None
        response["items"][i]["batch_number"] = item.batch.batch_number if item.batch else None
        response["items"][i]["expiry_date"] = item.batch.expiry_date.strftime("%d-%b-%Y") if (item.batch and item.batch.expiry_date) else None
        response["items"][i]["has_serial"] = bool(item.item.has_serial) if item.item else False
        response["items"][i]["has_batch"] = bool(item.item.has_batch) if item.item else False

    return response


@router.put("/{issue_id}", dependencies=[Depends(require_key("warehouse-material-issues"))])
async def update_vehicle_issue(
    issue_id: int,
    payload: VehicleIssueUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Update a draft vehicle issue."""
    result = await db.execute(
        select(VehicleIssue)
        .options(selectinload(VehicleIssue.items))
        .where(VehicleIssue.id == issue_id)
    )
    vi = result.scalar_one_or_none()
    if not vi:
        raise HTTPException(status_code=404, detail="Vehicle issue not found")
    if vi.status != "draft":
        raise HTTPException(status_code=400, detail="Only draft vehicle issues can be updated")

    # Update scalar fields
    if payload.indent_id is not None:
        vi.indent_id = payload.indent_id
    if payload.warehouse_id is not None:
        vi.warehouse_id = payload.warehouse_id
    if payload.vehicle_code is not None:
        vi.vehicle_code = payload.vehicle_code
    if payload.vehicle_number is not None:
        vi.vehicle_number = payload.vehicle_number
    if payload.issue_date is not None:
        vi.issue_date = payload.issue_date
    if payload.department is not None:
        vi.department = payload.department
    if payload.issued_to is not None:
        vi.issued_to = payload.issued_to
    if payload.remarks is not None:
        vi.remarks = payload.remarks
    if payload.project_id is not None:
        vi.project_id = payload.project_id

    # Resolve central warehouse
    target_wh_id = payload.warehouse_id if payload.warehouse_id is not None else vi.warehouse_id
    wh_row = await db.execute(select(Warehouse).where(Warehouse.id == target_wh_id))
    wh = wh_row.scalar_one_or_none()
    cfg_row = await db.execute(select(WarehouseConfig.is_central).where(WarehouseConfig.warehouse_id == target_wh_id))
    is_central = cfg_row.scalar()
    if is_central is None:
        is_central = wh is not None and wh.parent_id is None

    if not is_central and payload.items is not None:
        for it in payload.items:
            it.batch_id = None
            it.bin_id = None

    if payload.items is not None:
        await validate_material_issue_items_flow(db, target_wh_id, payload.items, is_central)

        # Delete existing items
        from sqlalchemy import delete as _sql_delete
        await db.execute(_sql_delete(VehicleIssueItem).where(VehicleIssueItem.vehicle_issue_id == vi.id))
        await db.flush()
        await db.refresh(vi, attribute_names=["items"])

        # Add new items
        for item in payload.items:
            amount = item.qty * item.rate
            cleaned_sns = await clean_serial_numbers(db, item.item_id, item.serial_numbers)
            vii = VehicleIssueItem(
                vehicle_issue_id=vi.id,
                item_id=item.item_id,
                batch_id=item.batch_id,
                qty=item.qty,
                uom_id=item.uom_id,
                bin_id=item.bin_id,
                rate=item.rate,
                amount=amount,
                serial_numbers=cleaned_sns,
                batch_number_text=item.batch_number_text,
                bin_code_text=item.bin_code_text,
            )
            db.add(vii)

    await db.flush()
    return {"id": vi.id, "issue_number": vi.issue_number, "message": "Vehicle issue updated successfully"}


@router.post("/{issue_id}/issue", dependencies=[Depends(require_key("warehouse-material-issues"))])
async def issue_vehicle_material(
    issue_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_permission(
        "warehouse-material-issues", "approve", "warehouse-material-issues"
    )),
):
    """Deduct/Reserve stock and mark vehicle issue as issued."""
    result = await db.execute(
        select(VehicleIssue)
        .options(selectinload(VehicleIssue.items).selectinload(VehicleIssueItem.item))
        .where(VehicleIssue.id == issue_id)
        .with_for_update()
    )
    vi = result.scalar_one_or_none()
    if not vi:
        raise HTTPException(status_code=404, detail="Vehicle issue not found")
    if vi.status != "draft":
        raise HTTPException(status_code=400, detail="Only draft vehicle issues can be issued")

    if not vi.items:
        raise HTTPException(status_code=400, detail="Vehicle issue has no items")

    # Resolve central warehouse
    wh_row = await db.execute(select(Warehouse).where(Warehouse.id == vi.warehouse_id))
    wh = wh_row.scalar_one_or_none()
    cfg_row = await db.execute(select(WarehouseConfig.is_central).where(WarehouseConfig.warehouse_id == vi.warehouse_id))
    is_central = cfg_row.scalar()
    if is_central is None:
        is_central = wh is not None and wh.parent_id is None

    # Validate stock availability in bulk first
    for item in vi.items:
        bal_conds = [
            StockBalance.item_id == item.item_id,
            StockBalance.warehouse_id == vi.warehouse_id,
        ]
        if is_central:
            if item.batch_id is not None:
                bal_conds.append(StockBalance.batch_id == item.batch_id)
            else:
                bal_conds.append(StockBalance.batch_id.is_(None))
            if item.bin_id is not None:
                bal_conds.append(StockBalance.bin_id == item.bin_id)

        bal_row = await db.execute(select(StockBalance).where(and_(*bal_conds)))
        balances = bal_row.scalars().all()
        avail = sum((b.available_qty or Decimal("0")) for b in balances) or Decimal("0")
        if (item.qty or Decimal("0")) > avail:
            raise HTTPException(
                status_code=400,
                detail=f"Insufficient stock for item {item.item_id}: available={avail}, requested={item.qty}"
            )

    # Update valuation rates
    for item in vi.items:
        balance = await _get_or_create_balance(
            db,
            item_id=item.item_id,
            warehouse_id=vi.warehouse_id,
            bin_id=item.bin_id,
            batch_id=item.batch_id,
        )
        effective_rate = balance.valuation_rate or Decimal("0")
        item.rate = effective_rate
        item.amount = (item.qty or Decimal("0")) * effective_rate

    # Update serial status if serial numbers are specified
    if is_central:
        for item in vi.items:
            if item.serial_numbers:
                sn_stmt = select(SerialNumber).where(
                    SerialNumber.item_id == item.item_id,
                    SerialNumber.serial_number.in_(item.serial_numbers),
                    SerialNumber.warehouse_id == vi.warehouse_id,
                    SerialNumber.status == "available"
                )
                sn_rows = (await db.execute(sn_stmt)).scalars().all()
                for sn in sn_rows:
                    sn.status = "issued"

    vi.status = "issued"
    vi.issued_by = current_user.id

    # Post stock ledger entries & update warehouse balance and vehicle stock balance
    for item in vi.items:
        if (item.qty or Decimal("0")) > 0:
            vsb = await post_vehicle_stock_ledger(
                db,
                item_id=item.item_id,
                warehouse_id=vi.warehouse_id,
                vehicle_code=vi.vehicle_code,
                vehicle_number=vi.vehicle_number,
                qty=item.qty,
                rate=item.rate,
                bin_id=item.bin_id,
                batch_id=item.batch_id,
                reference_type="vehicle_issue",
                reference_id=vi.id,
                uom_id=item.uom_id,
                created_by=current_user.id,
            )
            if item.serial_numbers and vsb:
                existing_serials = vsb.serial_numbers or []
                vsb.serial_numbers = list(set(existing_serials + (item.serial_numbers or [])))

    # Update indent issued qty if linked to an indent
    if vi.indent_id:
        indent_result = await db.execute(
            select(Indent).options(selectinload(Indent.items)).where(Indent.id == vi.indent_id)
        )
        indent = indent_result.scalar_one_or_none()
        if indent:
            for vi_item in vi.items:
                base_qty = vi_item.qty or Decimal("0")
                candidates = [il for il in indent.items if il.item_id == vi_item.item_id]
                remaining_to_credit = Decimal(str(base_qty))
                for ind_item in candidates:
                    if remaining_to_credit <= 0:
                        break
                    # Normalise UOM if needed
                    add_qty = remaining_to_credit
                    if ind_item.uom_id and vi_item.uom_id and ind_item.uom_id != vi_item.uom_id:
                        try:
                            cr = await db.execute(
                                select(_UC).where(
                                    _UC.from_uom_id == vi_item.uom_id,
                                    _UC.to_uom_id == ind_item.uom_id,
                                )
                            )
                            conv = cr.scalar_one_or_none()
                            if conv and conv.conversion_factor:
                                add_qty = remaining_to_credit * Decimal(str(conv.conversion_factor))
                        except Exception:
                            pass

                    target = Decimal(str(ind_item.approved_qty or ind_item.requested_qty or 0))
                    already = Decimal(str(ind_item.issued_qty or 0))
                    capacity = target - already
                    if capacity <= 0:
                        continue
                    take = min(add_qty, capacity)
                    ind_item.issued_qty = already + take
                    remaining_to_credit -= take
                if remaining_to_credit > 0 and candidates:
                    candidates[-1].issued_qty = (candidates[-1].issued_qty or Decimal("0")) + remaining_to_credit

    await db.flush()
    return {"id": vi.id, "issue_number": vi.issue_number, "message": "Vehicle issue confirmed successfully, stock reserved"}


@router.post("/{issue_id}/cancel", dependencies=[Depends(require_key("warehouse-material-issues"))])
async def cancel_vehicle_issue(
    issue_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_permission(
        "warehouse-material-issues", "delete", "warehouse-material-issues"
    )),
):
    """Cancel a draft or issued vehicle issue and release reservations."""
    result = await db.execute(
        select(VehicleIssue)
        .options(selectinload(VehicleIssue.items))
        .where(VehicleIssue.id == issue_id)
        .with_for_update()
    )
    vi = result.scalar_one_or_none()
    if not vi:
        raise HTTPException(status_code=404, detail="Vehicle issue not found")
    if vi.status not in ("draft", "issued"):
        raise HTTPException(status_code=400, detail="Cannot cancel vehicle issue in current status")

    if vi.status == "issued":
        # Revert serial status
        for item in vi.items:
            if item.serial_numbers:
                sn_stmt = select(SerialNumber).where(
                    SerialNumber.item_id == item.item_id,
                    SerialNumber.serial_number.in_(item.serial_numbers),
                    SerialNumber.warehouse_id == vi.warehouse_id,
                    SerialNumber.status == "issued"
                )
                sn_rows = (await db.execute(sn_stmt)).scalars().all()
                for sn in sn_rows:
                    sn.status = "available"

    vi.status = "cancelled"
    await db.flush()
    return {"id": vi.id, "issue_number": vi.issue_number, "message": "Vehicle issue cancelled successfully"}
