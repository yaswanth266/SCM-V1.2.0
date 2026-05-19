import logging
from decimal import Decimal
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select, func, and_, or_
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload, aliased
from app.database import get_db
from app.models.user import User, Project
from app.models.accounts import (
    ChartOfAccounts, Invoice, InvoiceItem, Payment,
    CreditNote, JournalEntry, JournalEntryLine, AccountLedger,
    AccountMapping, FiscalYear,
)
from app.models.master import Vendor
from app.models.procurement import PurchaseOrder
from app.schemas.accounts import (
    AccountCreate, AccountResponse,
    InvoiceCreate, InvoiceUpdate, InvoiceResponse,
    PaymentCreate, PaymentResponse,
    CreditNoteCreate, CreditNoteResponse,
    JournalEntryCreate, JournalEntryResponse, JournalEntryLineResponse,
    AccountLedgerResponse,
)
from app.services.number_series import generate_number
from app.utils.dependencies import get_current_user, require_any_role, require_permission, require_key
from app.utils.helpers import paginate_params, build_paginated_response, apply_search_filter

logger = logging.getLogger(__name__)
router = APIRouter()


# ==================== CHART OF ACCOUNTS ====================

@router.get("/chart-of-accounts")
async def list_accounts(
    account_type: str = Query(None),
    project_id: int = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    # BUG-FIN-161: scope CoA to the caller's organization to prevent
    # cross-org leak of account codes/balances.
    org_id = current_user.organization_id or 1
    query = select(ChartOfAccounts).where(
        ChartOfAccounts.is_active == True,
        ChartOfAccounts.organization_id == org_id,
    )
    if account_type:
        query = query.where(ChartOfAccounts.account_type == account_type)
    if project_id:
        query = query.where(ChartOfAccounts.project_id == project_id)
    result = await db.execute(query.order_by(ChartOfAccounts.account_code))
    accounts = result.scalars().all()
    return [AccountResponse.model_validate(a) for a in accounts]


@router.post("/chart-of-accounts", status_code=201)
async def create_account(
    payload: AccountCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_any_role("super_admin", "admin", "accounts_manager")),
):
    account = ChartOfAccounts(**payload.model_dump())
    db.add(account)
    await db.flush()
    return {"id": account.id, "message": "Account created"}


# ==================== INVOICES ====================

@router.get("/invoices", dependencies=[Depends(require_key("accounts-invoices"))])
async def list_invoices(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    search: str = Query(None),
    status: str = Query(None),
    status_in: str = Query(None, description="CSV of statuses (e.g. submitted,partially_paid)"),
    invoice_type: str = Query(None),
    party_type: str = Query(None),
    party_id: int = Query(None),
    project_id: int = Query(None),
    overdue: bool = Query(False, description="Filter to overdue invoices only (BUG-FIN-045/149)"),
    date_from: str = Query(None, description="ISO date filter on invoice_date (BUG-FIN-046)"),
    date_to: str = Query(None, description="ISO date filter on invoice_date (BUG-FIN-046)"),
    db: AsyncSession = Depends(get_db),
    # R-001: read-level RBAC enforcement
    current_user: User = Depends(require_permission("accounts", "view", "invoices")),
):
    offset, limit = paginate_params(page, page_size)
    Creator = aliased(User, flat=True)
    query = (
        select(
            Invoice,
            Vendor.name.label("party_name"),
            PurchaseOrder.po_number.label("po_number"),
            Project.name.label("project_name"),
            func.concat(Creator.first_name, " ", func.coalesce(Creator.last_name, "")).label("creator_name"),
        )
        .options(selectinload(Invoice.items))
        .outerjoin(Vendor, and_(Invoice.party_type == "vendor", Invoice.party_id == Vendor.id))
        .outerjoin(PurchaseOrder, Invoice.po_id == PurchaseOrder.id)
        .outerjoin(Project, Invoice.project_id == Project.id)
        .outerjoin(Creator, Invoice.created_by == Creator.id)
    )
    count_query = select(func.count(Invoice.id))

    if status:
        query = query.where(Invoice.status == status)
        count_query = count_query.where(Invoice.status == status)
    # BUG-FIN-047: support CSV status_in filter so PaymentForm can show only
    # invoices that still owe money.
    if status_in:
        statuses = [s.strip() for s in status_in.split(",") if s.strip()]
        if statuses:
            query = query.where(Invoice.status.in_(statuses))
            count_query = count_query.where(Invoice.status.in_(statuses))
    if invoice_type:
        query = query.where(Invoice.invoice_type == invoice_type)
        count_query = count_query.where(Invoice.invoice_type == invoice_type)
    if party_type:
        query = query.where(Invoice.party_type == party_type)
        count_query = count_query.where(Invoice.party_type == party_type)
    if party_id:
        query = query.where(Invoice.party_id == party_id)
        count_query = count_query.where(Invoice.party_id == party_id)
    if project_id:
        query = query.where(Invoice.project_id == project_id)
        count_query = count_query.where(Invoice.project_id == project_id)

    # BUG-FIN-045/149: overdue filter — invoices past due_date with non-zero balance.
    if overdue:
        from datetime import date as _date
        today = _date.today()
        query = query.where(
            Invoice.due_date < today,
            Invoice.balance_amount > 0,
            Invoice.status.notin_(["paid", "cancelled"]),
        )
        count_query = count_query.where(
            Invoice.due_date < today,
            Invoice.balance_amount > 0,
            Invoice.status.notin_(["paid", "cancelled"]),
        )
    # BUG-FIN-046: date range filter on invoice_date.
    if date_from:
        from datetime import date as _date
        try:
            df = _date.fromisoformat(date_from)
            query = query.where(Invoice.invoice_date >= df)
            count_query = count_query.where(Invoice.invoice_date >= df)
        except Exception:
            pass
    if date_to:
        from datetime import date as _date
        try:
            dt = _date.fromisoformat(date_to)
            query = query.where(Invoice.invoice_date <= dt)
            count_query = count_query.where(Invoice.invoice_date <= dt)
        except Exception:
            pass

    # BUG-FIN-165: also search across the joined vendor name so users can
    # find invoices by typing the supplier (the FE box says "search invoices").
    if search:
        like = f"%{search}%"
        query = query.where(or_(
            Invoice.invoice_number.ilike(like),
            Vendor.name.ilike(like),
        ))
        # Apply the same to the count_query, but it doesn't currently join
        # Vendor — add an outer join scoped to the search predicate.
        count_query = (
            count_query
            .outerjoin(Vendor, and_(Invoice.party_type == "vendor", Invoice.party_id == Vendor.id))
            .where(or_(
                Invoice.invoice_number.ilike(like),
                Vendor.name.ilike(like),
            ))
        )

    total = (await db.execute(count_query)).scalar()
    result = await db.execute(query.offset(offset).limit(limit).order_by(Invoice.id.desc()))
    rows = result.all()
    invoices = []
    for row in rows:
        inv = row[0]
        data = InvoiceResponse.model_validate(inv)
        data.party_name = row.party_name
        data.po_number = row.po_number
        data.project_name = row.project_name
        data.creator_name = row.creator_name.strip() if row.creator_name else None
        invoices.append(data)
    return build_paginated_response(invoices, total, page, page_size)


@router.get("/invoices/{invoice_id}/payments", dependencies=[Depends(require_key("accounts-invoices"))])
async def list_invoice_payments(
    invoice_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_permission("accounts", "view", "payments")),
):
    """List payments linked to a specific invoice.

    BUG-FIN-048: UI was calling this endpoint but it didn't exist (404).
    """
    inv = (await db.execute(select(Invoice).where(Invoice.id == invoice_id))).scalar_one_or_none()
    if not inv:
        raise HTTPException(status_code=404, detail="Invoice not found")
    rows = (await db.execute(
        select(Payment)
        .where(Payment.invoice_id == invoice_id)
        .order_by(Payment.payment_date.desc(), Payment.id.desc())
    )).scalars().all()
    return [PaymentResponse.model_validate(p) for p in rows]


@router.get("/invoices/{invoice_id}/print", dependencies=[Depends(require_key("accounts-invoices"))])
async def get_invoice_print(
    invoice_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_permission("accounts", "view", "invoices")),
):
    """Return printable invoice payload (header + items + party).

    BUG-FIN-049: UI was calling this endpoint but it did not exist (404).
    The frontend renders/exports as PDF — backend just returns a stable
    JSON shape with name strings already resolved.
    """
    inv_row = (await db.execute(
        select(Invoice).options(selectinload(Invoice.items)).where(Invoice.id == invoice_id)
    )).scalar_one_or_none()
    if not inv_row:
        raise HTTPException(status_code=404, detail="Invoice not found")
    party_name = None
    try:
        if inv_row.party_type == "vendor":
            party_name = (await db.execute(
                select(Vendor.name).where(Vendor.id == inv_row.party_id)
            )).scalar_one_or_none()
    except Exception:
        party_name = None
    project_name = None
    if inv_row.project_id:
        project_name = (await db.execute(
            select(Project.name).where(Project.id == inv_row.project_id)
        )).scalar_one_or_none()
    items = [{
        "item_id": ii.item_id,
        "qty": float(ii.qty or 0),
        "uom_id": ii.uom_id,
        "rate": float(ii.rate or 0),
        "discount_pct": float(ii.discount_pct or 0),
        "cgst_rate": float(ii.cgst_rate or 0),
        "sgst_rate": float(ii.sgst_rate or 0),
        "igst_rate": float(ii.igst_rate or 0),
        "tax_amount": float(ii.tax_amount or 0),
        "amount": float(ii.amount or 0),
    } for ii in (inv_row.items or [])]
    return {
        "id": inv_row.id,
        "invoice_number": inv_row.invoice_number,
        "invoice_type": inv_row.invoice_type,
        "party_type": inv_row.party_type,
        "party_id": inv_row.party_id,
        "party_name": party_name,
        "project_id": inv_row.project_id,
        "project_name": project_name,
        "invoice_date": inv_row.invoice_date.isoformat() if inv_row.invoice_date else None,
        "due_date": inv_row.due_date.isoformat() if inv_row.due_date else None,
        "subtotal": float(inv_row.subtotal or 0),
        "cgst_amount": float(inv_row.cgst_amount or 0),
        "sgst_amount": float(inv_row.sgst_amount or 0),
        "igst_amount": float(inv_row.igst_amount or 0),
        "tax_amount": float(inv_row.tax_amount or 0),
        "grand_total": float(inv_row.grand_total or 0),
        "paid_amount": float(inv_row.paid_amount or 0),
        "balance_amount": float(inv_row.balance_amount or 0),
        "status": inv_row.status,
        "remarks": inv_row.remarks,
        "items": items,
    }


@router.get("/invoices/{invoice_id}", response_model=InvoiceResponse, dependencies=[Depends(require_key("accounts-invoices"))])
async def get_invoice(
    invoice_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    result = await db.execute(
        select(Invoice).options(selectinload(Invoice.items)).where(Invoice.id == invoice_id)
    )
    inv = result.scalar_one_or_none()
    if not inv:
        raise HTTPException(status_code=404, detail="Invoice not found")
    return InvoiceResponse.model_validate(inv)


@router.post("/invoices", status_code=201, dependencies=[Depends(require_key("accounts-invoices"))])
async def create_invoice(
    payload: InvoiceCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_any_role("super_admin", "admin", "accounts_manager", "accounts_officer")),
):
    inv_number = await generate_number(db, "accounts", "invoice")
    subtotal = Decimal("0")
    total_tax = Decimal("0")
    total_cgst = Decimal("0")
    total_sgst = Decimal("0")
    total_igst = Decimal("0")

    inv = Invoice(
        invoice_number=inv_number,
        invoice_type=payload.invoice_type,
        party_type=payload.party_type,
        party_id=payload.party_id,
        po_id=payload.po_id,
        so_id=payload.so_id,
        project_id=payload.project_id,
        invoice_date=payload.invoice_date,
        due_date=payload.due_date,
        remarks=payload.remarks,
        created_by=current_user.id,
    )
    db.add(inv)
    await db.flush()

    # BUG-FIN-027: quantize each line to 2 decimal places so per-line writes
    # match the database column precision and the GL journal totals match
    # the persisted line amounts (no paise drift).
    from decimal import ROUND_HALF_UP
    Q2 = Decimal("0.01")

    for item in payload.items:
        base = (item.qty * item.rate)
        # BUG-FIN-029: quantize per-line discount before subtracting so the
        # accumulated subtotal reconciles with an invoice-level discount audit
        # (₹0.005 per row otherwise drifts out of the GL).
        discount = (base * item.discount_pct / 100).quantize(Q2, rounding=ROUND_HALF_UP)
        net = (base - discount).quantize(Q2, rounding=ROUND_HALF_UP)
        cgst = (net * item.cgst_rate / 100).quantize(Q2, rounding=ROUND_HALF_UP)
        sgst = (net * item.sgst_rate / 100).quantize(Q2, rounding=ROUND_HALF_UP)
        igst = (net * item.igst_rate / 100).quantize(Q2, rounding=ROUND_HALF_UP)
        item_tax = (cgst + sgst + igst).quantize(Q2, rounding=ROUND_HALF_UP)
        amount = (net + item_tax).quantize(Q2, rounding=ROUND_HALF_UP)

        ii = InvoiceItem(
            invoice_id=inv.id, item_id=item.item_id, qty=item.qty,
            uom_id=item.uom_id, rate=item.rate, discount_pct=item.discount_pct,
            cgst_rate=item.cgst_rate, sgst_rate=item.sgst_rate,
            igst_rate=item.igst_rate, tax_amount=item_tax, amount=amount,
        )
        db.add(ii)
        subtotal += net
        total_tax += item_tax
        total_cgst += cgst
        total_sgst += sgst
        total_igst += igst

    inv.subtotal = subtotal.quantize(Q2, rounding=ROUND_HALF_UP)
    inv.tax_amount = total_tax.quantize(Q2, rounding=ROUND_HALF_UP)
    inv.cgst_amount = total_cgst.quantize(Q2, rounding=ROUND_HALF_UP)
    inv.sgst_amount = total_sgst.quantize(Q2, rounding=ROUND_HALF_UP)
    inv.igst_amount = total_igst.quantize(Q2, rounding=ROUND_HALF_UP)
    inv.grand_total = (inv.subtotal + inv.tax_amount).quantize(Q2, rounding=ROUND_HALF_UP)
    inv.balance_amount = inv.grand_total
    await db.flush()

    # GL posting: purchase → GR-IR Dr + GST input Dr / AP Cr
    #             sales → AR Dr / Sales Cr + GST output Cr
    # BUG-FIN-011/042: tax components now passed so GST is split off net.
    # BUG-FIN-012: derive warehouse_id from the linked PO so account-mapping
    # resolution can pick the per-warehouse override when configured.
    inv_warehouse_id = None
    if payload.po_id:
        try:
            po_wh_row = await db.execute(
                select(PurchaseOrder.warehouse_id).where(PurchaseOrder.id == payload.po_id)
            )
            inv_warehouse_id = po_wh_row.scalar_one_or_none()
        except Exception:
            inv_warehouse_id = None
    try:
        from app.services.gl_posting import post_invoice_gl
        org_id = current_user.organization_id or 1
        await post_invoice_gl(
            db,
            organization_id=org_id,
            invoice_id=inv.id,
            invoice_number=inv_number,
            invoice_date=inv.invoice_date,
            invoice_type=inv.invoice_type,
            party_type=inv.party_type,
            party_id=inv.party_id,
            grand_total=inv.grand_total,
            subtotal=inv.subtotal,
            cgst_amount=inv.cgst_amount,
            sgst_amount=inv.sgst_amount,
            igst_amount=inv.igst_amount,
            warehouse_id=inv_warehouse_id,
            created_by=current_user.id,
        )
    except Exception:
        logger.exception("GL posting failed for invoice %s", inv_number)

    return {"id": inv.id, "invoice_number": inv_number, "message": "Invoice created"}


@router.put("/invoices/{invoice_id}", dependencies=[Depends(require_key("accounts-invoices"))])
async def update_invoice(
    invoice_id: int,
    payload: InvoiceUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    result = await db.execute(select(Invoice).where(Invoice.id == invoice_id))
    inv = result.scalar_one_or_none()
    if not inv:
        raise HTTPException(status_code=404, detail="Invoice not found")

    # BUG-FIN-017: reverse the original GL JE if status transitions to cancelled.
    new_data = payload.model_dump(exclude_unset=True)
    prev_status = inv.status
    is_cancellation = (
        "status" in new_data
        and new_data["status"] == "cancelled"
        and prev_status != "cancelled"
    )

    # BUG-FIN-043: whitelist updatable fields. Critical financial columns
    # (subtotal, tax_amount, grand_total, paid_amount, balance_amount) must
    # never be set via PUT — they're recomputed from line items / payments.
    ALLOWED_UPDATE_FIELDS = {
        "invoice_date", "due_date", "remarks", "status",
        "po_id", "so_id", "project_id", "attachment_url",
    }
    for k, v in new_data.items():
        if k in ALLOWED_UPDATE_FIELDS:
            setattr(inv, k, v)
    await db.flush()

    if is_cancellation:
        try:
            from app.services.gl_posting import reverse_journal_entries
            from datetime import datetime as _dt
            org_id = current_user.organization_id or 1
            await reverse_journal_entries(
                db,
                organization_id=org_id,
                reference_type="invoice",
                reference_id=inv.id,
                reversal_date=_dt.utcnow(),
                narration=f"Reversal: invoice {inv.invoice_number} cancelled",
                created_by=current_user.id,
            )
        except Exception:
            logger.exception("GL reversal failed for cancelled invoice %s", inv.invoice_number)

    return {"success": True, "message": "Invoice updated"}


@router.post("/invoices/{invoice_id}/cancel", dependencies=[Depends(require_key("accounts-invoices"))])
async def cancel_invoice(
    invoice_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_any_role("super_admin", "admin", "accounts_manager")),
):
    """Cancel an invoice and reverse its GL JE (BUG-FIN-017)."""
    result = await db.execute(select(Invoice).where(Invoice.id == invoice_id))
    inv = result.scalar_one_or_none()
    if not inv:
        raise HTTPException(status_code=404, detail="Invoice not found")
    if inv.status == "cancelled":
        return {"success": True, "message": "Already cancelled"}
    if (inv.paid_amount or Decimal("0")) > 0:
        raise HTTPException(status_code=400, detail="Cannot cancel a partially/fully paid invoice; use credit note")

    inv.status = "cancelled"
    inv.balance_amount = Decimal("0")
    await db.flush()

    try:
        from app.services.gl_posting import reverse_journal_entries
        from datetime import datetime as _dt
        org_id = current_user.organization_id or 1
        await reverse_journal_entries(
            db,
            organization_id=org_id,
            reference_type="invoice",
            reference_id=inv.id,
            reversal_date=_dt.utcnow(),
            narration=f"Reversal: invoice {inv.invoice_number} cancelled",
            created_by=current_user.id,
        )
    except Exception:
        logger.exception("GL reversal failed for cancelled invoice %s", inv.invoice_number)

    return {"success": True, "message": "Invoice cancelled"}


# ==================== PAYMENTS ====================

@router.get("/payments")
async def list_payments(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    search: str = Query(None),
    party_type: str = Query(None),
    party_id: int = Query(None),
    status: str = Query(None),
    payment_mode: str = Query(None),  # Bug fix BUG_0017
    payment_type: str = Query(None, description="receive|pay (BUG-FIN-034)"),
    project_id: int = Query(None),
    date_from: str = Query(None, description="ISO date (BUG-FIN-035)"),
    date_to: str = Query(None, description="ISO date (BUG-FIN-035)"),
    db: AsyncSession = Depends(get_db),
    # R-001: read-level RBAC enforcement
    current_user: User = Depends(require_permission("accounts", "view", "payments")),
):
    offset, limit = paginate_params(page, page_size)
    PayCreator = aliased(User, flat=True)
    query = (
        select(
            Payment,
            Vendor.name.label("party_name"),
            Project.name.label("project_name"),
            func.concat(PayCreator.first_name, " ", func.coalesce(PayCreator.last_name, "")).label("creator_name"),
        )
        .outerjoin(Vendor, and_(Payment.party_type == "vendor", Payment.party_id == Vendor.id))
        .outerjoin(Project, Payment.project_id == Project.id)
        .outerjoin(PayCreator, Payment.created_by == PayCreator.id)
    )
    count_query = select(func.count(Payment.id))

    if party_type:
        query = query.where(Payment.party_type == party_type)
        count_query = count_query.where(Payment.party_type == party_type)
    if party_id:
        query = query.where(Payment.party_id == party_id)
        count_query = count_query.where(Payment.party_id == party_id)
    if status:
        query = query.where(Payment.status == status)
        count_query = count_query.where(Payment.status == status)
    if payment_mode:
        # Bug fix BUG_0017: filter was being ignored, dropdown didn't work
        query = query.where(Payment.payment_mode == payment_mode)
        count_query = count_query.where(Payment.payment_mode == payment_mode)
    if payment_type:
        # BUG-FIN-034: support payment_type filter the UI sends.
        query = query.where(Payment.payment_type == payment_type)
        count_query = count_query.where(Payment.payment_type == payment_type)
    if project_id:
        query = query.where(Payment.project_id == project_id)
        count_query = count_query.where(Payment.project_id == project_id)
    # BUG-FIN-035: support date_from/date_to filters the UI sends.
    if date_from:
        from datetime import date as _date
        try:
            df = _date.fromisoformat(date_from)
            query = query.where(Payment.payment_date >= df)
            count_query = count_query.where(Payment.payment_date >= df)
        except Exception:
            pass
    if date_to:
        from datetime import date as _date
        try:
            dt = _date.fromisoformat(date_to)
            query = query.where(Payment.payment_date <= dt)
            count_query = count_query.where(Payment.payment_date <= dt)
        except Exception:
            pass

    query = apply_search_filter(query, Payment, search, ["payment_number", "reference_number"])
    count_query = apply_search_filter(count_query, Payment, search, ["payment_number", "reference_number"])

    total = (await db.execute(count_query)).scalar()
    result = await db.execute(query.offset(offset).limit(limit).order_by(Payment.id.desc()))
    rows = result.all()
    payments = []
    for row in rows:
        pay = row[0]
        data = PaymentResponse.model_validate(pay)
        data.party_name = row.party_name
        data.project_name = row.project_name
        data.creator_name = row.creator_name.strip() if row.creator_name else None
        payments.append(data)
    return build_paginated_response(payments, total, page, page_size)


@router.post("/payments", status_code=201)
async def create_payment(
    payload: PaymentCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_any_role("super_admin", "admin", "accounts_manager", "accounts_officer")),
):
    # BUG-FIN-036: server-side guard so a 0 or negative payment can't bypass
    # the UI min=0.01 (eg. via direct API). The Pydantic schema doesn't
    # enforce gt=0 today.
    pay_amount = Decimal(str(payload.amount or 0))
    if pay_amount <= 0:
        raise HTTPException(status_code=400, detail="Payment amount must be greater than zero")

    # B5 fix: validate overpayment BEFORE creating the payment record.
    # BUG-FIN-032: validation failures raise HTTPException, which causes the
    # surrounding request transaction to roll back — releasing the row lock
    # naturally. Make the contract explicit by handling errors after the
    # lookup so callers see consistent error messages.
    inv = None
    if payload.invoice_id:
        inv_result = await db.execute(
            select(Invoice).where(Invoice.id == payload.invoice_id).with_for_update()
        )
        inv = inv_result.scalar_one_or_none()
        if not inv:
            raise HTTPException(status_code=404, detail="Invoice not found")
        balance_due = (inv.grand_total or Decimal("0")) - (inv.paid_amount or Decimal("0"))
        if pay_amount > balance_due:
            raise HTTPException(
                status_code=400,
                detail=f"Payment amount ({pay_amount}) exceeds balance due ({balance_due})"
            )

    pay_number = await generate_number(db, "accounts", "payment")
    payment = Payment(
        payment_number=pay_number, **payload.model_dump(),
        created_by=current_user.id,
    )
    # BUG-FIN-033: default-status was "draft" but GL was posting immediately.
    # Set to "submitted" on creation so the JE matches the recorded state.
    if not getattr(payment, "status", None) or payment.status == "draft":
        payment.status = "submitted"
    db.add(payment)
    await db.flush()

    # Update invoice balance (validation already passed above)
    if inv:
        inv.paid_amount = (inv.paid_amount or Decimal("0")) + pay_amount
        # BUG-FIN-041: clamp balance at 0 — never allow it to go negative.
        # Earlier the value could drift negative when partially_paid edits
        # cascaded out-of-order updates.
        inv.balance_amount = max(Decimal("0"), (inv.grand_total or Decimal("0")) - inv.paid_amount)
        if inv.balance_amount <= 0:
            inv.status = "paid"
        else:
            inv.status = "partially_paid"

    await db.flush()

    # GL posting: pay → AP Dr / Bank Cr    receive → Bank Dr / AR Cr
    try:
        from app.services.gl_posting import post_payment_gl
        org_id = current_user.organization_id or 1
        await post_payment_gl(
            db,
            organization_id=org_id,
            payment_id=payment.id,
            payment_number=pay_number,
            payment_date=payment.payment_date,
            payment_type=payment.payment_type,
            party_type=payment.party_type,
            party_id=payment.party_id,
            amount=payment.amount,
            created_by=current_user.id,
        )
    except Exception:
        logger.exception("GL posting failed for payment %s", pay_number)

    return {"id": payment.id, "payment_number": pay_number, "message": "Payment created"}


@router.get("/payments/{payment_id}", response_model=PaymentResponse)
async def get_payment(
    payment_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_permission("accounts", "view", "payments")),
):
    """Fetch a single payment for the edit form (BUG-FIN-150)."""
    result = await db.execute(select(Payment).where(Payment.id == payment_id))
    pay = result.scalar_one_or_none()
    if not pay:
        raise HTTPException(status_code=404, detail="Payment not found")
    return PaymentResponse.model_validate(pay)


@router.put("/payments/{payment_id}")
async def update_payment(
    payment_id: int,
    payload: dict,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_any_role("super_admin", "admin", "accounts_manager")),
):
    """Edit non-financial fields on a payment.

    BUG-FIN-037: UI Edit was returning 405. Whitelist non-financial fields
    only — `amount`, `invoice_id`, `party_id` are immutable post-creation
    because changes there desync the GL JE and invoice balance.
    """
    result = await db.execute(select(Payment).where(Payment.id == payment_id))
    pay = result.scalar_one_or_none()
    if not pay:
        raise HTTPException(status_code=404, detail="Payment not found")
    if pay.status == "cancelled":
        raise HTTPException(status_code=400, detail="Cannot edit a cancelled payment")
    ALLOWED = {"reference_number", "bank_account", "remarks", "payment_mode", "payment_date"}
    for k, v in payload.items():
        if k in ALLOWED:
            setattr(pay, k, v)
    await db.flush()
    return {"success": True, "message": "Payment updated"}


@router.delete("/payments/{payment_id}")
async def delete_payment(
    payment_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_any_role("super_admin", "admin", "accounts_manager")),
):
    """Delete a payment.

    BUG-FIN-038: UI Delete was returning 405. Only allow deletion when the
    payment hasn't been reconciled and it carries no GL JE — otherwise
    callers should use the cancel endpoint to issue a reversing JE.
    """
    result = await db.execute(select(Payment).where(Payment.id == payment_id))
    pay = result.scalar_one_or_none()
    if not pay:
        raise HTTPException(status_code=404, detail="Payment not found")
    if pay.status in ("reconciled", "submitted"):
        raise HTTPException(
            status_code=400,
            detail="Cannot delete a posted/reconciled payment; use cancel endpoint to reverse",
        )
    # Restore invoice balance if linked
    if pay.invoice_id:
        inv_res = await db.execute(
            select(Invoice).where(Invoice.id == pay.invoice_id).with_for_update()
        )
        inv = inv_res.scalar_one_or_none()
        if inv:
            inv.paid_amount = max(Decimal("0"), (inv.paid_amount or Decimal("0")) - (pay.amount or Decimal("0")))
            inv.balance_amount = (inv.grand_total or Decimal("0")) - inv.paid_amount
            if inv.paid_amount <= 0:
                inv.status = "submitted"
            elif inv.balance_amount > 0:
                inv.status = "partially_paid"
    await db.delete(pay)
    await db.flush()
    return {"success": True, "message": "Payment deleted"}


@router.post("/payments/{payment_id}/cancel")
async def cancel_payment(
    payment_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_any_role("super_admin", "admin", "accounts_manager")),
):
    """Cancel a payment, reverse its GL JE, and restore the linked invoice balance.

    BUG-FIN-018: previously there was no cancel endpoint; payments stayed
    posted and invoice balances stayed reduced even after intent to void.
    """
    result = await db.execute(
        select(Payment).where(Payment.id == payment_id).with_for_update()
    )
    pay = result.scalar_one_or_none()
    if not pay:
        raise HTTPException(status_code=404, detail="Payment not found")
    if pay.status == "cancelled":
        return {"success": True, "message": "Already cancelled"}

    amount = pay.amount or Decimal("0")

    # Restore the linked invoice's balance/paid amount.
    if pay.invoice_id:
        inv_res = await db.execute(
            select(Invoice).where(Invoice.id == pay.invoice_id).with_for_update()
        )
        inv = inv_res.scalar_one_or_none()
        if inv:
            inv.paid_amount = max(Decimal("0"), (inv.paid_amount or Decimal("0")) - amount)
            inv.balance_amount = (inv.grand_total or Decimal("0")) - inv.paid_amount
            if inv.balance_amount >= inv.grand_total:
                inv.status = "submitted"
            elif inv.paid_amount > 0:
                inv.status = "partially_paid"

    pay.status = "cancelled"
    await db.flush()

    try:
        from app.services.gl_posting import reverse_journal_entries
        from datetime import datetime as _dt
        org_id = current_user.organization_id or 1
        await reverse_journal_entries(
            db,
            organization_id=org_id,
            reference_type="payment",
            reference_id=pay.id,
            reversal_date=_dt.utcnow(),
            narration=f"Reversal: payment {pay.payment_number} cancelled",
            created_by=current_user.id,
        )
    except Exception:
        logger.exception("GL reversal failed for cancelled payment %s", pay.payment_number)

    return {"success": True, "message": "Payment cancelled and reversed"}


# ==================== CREDIT NOTES ====================

@router.get("/credit-notes")
async def list_credit_notes(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    search: str = Query(None),
    status: str = Query(None),
    party_type: str = Query(None),
    party_id: int = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    offset, limit = paginate_params(page, page_size)
    # BUG-FIN-054: Project was joined via Invoice but Invoice may be NULL for
    # standalone CNs. Use an explicit COALESCE: prefer CreditNote.project_id
    # if the column exists; otherwise fall back to Invoice.project_id only
    # when the invoice link is present.
    cn_project_id_col = getattr(CreditNote, "project_id", None)
    query = (
        select(
            CreditNote,
            Vendor.name.label("party_name"),
            Project.name.label("project_name"),
        )
        .outerjoin(Vendor, and_(CreditNote.party_type == "vendor", CreditNote.party_id == Vendor.id))
        .outerjoin(Invoice, CreditNote.invoice_id == Invoice.id)
        .outerjoin(
            Project,
            (cn_project_id_col == Project.id) if cn_project_id_col is not None
            else (Invoice.project_id == Project.id),
        )
    )
    count_query = select(func.count(CreditNote.id))

    if status:
        query = query.where(CreditNote.status == status)
        count_query = count_query.where(CreditNote.status == status)
    if party_type:
        query = query.where(CreditNote.party_type == party_type)
        count_query = count_query.where(CreditNote.party_type == party_type)
    if party_id:
        query = query.where(CreditNote.party_id == party_id)
        count_query = count_query.where(CreditNote.party_id == party_id)

    query = apply_search_filter(query, CreditNote, search, ["cn_number"])
    count_query = apply_search_filter(count_query, CreditNote, search, ["cn_number"])

    total = (await db.execute(count_query)).scalar()
    result = await db.execute(query.offset(offset).limit(limit).order_by(CreditNote.id.desc()))
    rows = result.all()
    cns = []
    for row in rows:
        cn = row[0]
        data = CreditNoteResponse.model_validate(cn)
        data.party_name = row.party_name
        data.project_name = row.project_name
        cns.append(data)
    return build_paginated_response(cns, total, page, page_size)


@router.post("/credit-notes", status_code=201)
async def create_credit_note(
    payload: CreditNoteCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_any_role("super_admin", "admin", "accounts_manager", "accounts_officer")),
):
    from datetime import datetime as _dt, date as _date
    data = payload.model_dump(exclude_none=True)

    # Auto-derive party_type/party_id/cn_date from linked invoice when frontend omits them
    inv_result = await db.execute(
        select(Invoice).where(Invoice.id == payload.invoice_id).with_for_update()
    )
    inv = inv_result.scalar_one_or_none()
    if not inv:
        raise HTTPException(status_code=404, detail="Invoice not found")

    # BUG-FIN-055: cap total credit-notes against an invoice at the
    # outstanding balance to prevent over-credit (functions as overpayment).
    new_amount = Decimal(str(payload.amount or 0))
    existing_cn_total = (await db.execute(
        select(func.coalesce(func.sum(CreditNote.amount), 0)).where(
            CreditNote.invoice_id == payload.invoice_id,
            CreditNote.status != "cancelled",
        )
    )).scalar() or Decimal("0")
    available_to_credit = (inv.grand_total or Decimal("0")) - (inv.paid_amount or Decimal("0"))
    if Decimal(str(existing_cn_total)) + new_amount > available_to_credit:
        raise HTTPException(
            status_code=400,
            detail=(
                f"Total credit notes ({Decimal(str(existing_cn_total)) + new_amount}) "
                f"exceeds outstanding balance ({available_to_credit}) on invoice {inv.invoice_number}"
            ),
        )
    if not data.get("party_type"):
        data["party_type"] = getattr(inv, "party_type", None) or "vendor"
    if not data.get("party_id"):
        data["party_id"] = getattr(inv, "party_id", None) or getattr(inv, "vendor_id", None)
    if not data.get("cn_date"):
        data["cn_date"] = _date.today()

    remarks = data.pop("remarks", None)

    cn_number = await generate_number(db, "accounts", "credit_note")
    cn = CreditNote(cn_number=cn_number, **data)
    if remarks is not None and hasattr(CreditNote, "remarks"):
        cn.remarks = remarks
    db.add(cn)
    await db.flush()

    # BUG-FIN-020: decrement linked invoice's balance & paid-equivalent so
    # AR/AP aging reflects the credit. The CN amount reduces what's owed.
    try:
        cn_amt = Decimal(str(cn.amount or 0))
        if cn_amt > 0 and inv is not None:
            # Treat the CN like a payment of `cn_amt` against the invoice
            inv.paid_amount = (inv.paid_amount or Decimal("0")) + cn_amt
            inv.balance_amount = max(
                Decimal("0"),
                (inv.grand_total or Decimal("0")) - inv.paid_amount,
            )
            if inv.balance_amount <= 0:
                inv.status = "paid"
            elif inv.paid_amount > 0 and inv.status not in ("cancelled",):
                inv.status = "partially_paid"
            await db.flush()
    except Exception:
        logger.exception("Failed to update invoice balance for credit note %s", cn_number)

    # BUG-FIN-019: post GL for the credit note (reverses a slice of the invoice's JE).
    try:
        from app.services.gl_posting import post_credit_note_gl
        org_id = current_user.organization_id or 1
        await post_credit_note_gl(
            db,
            organization_id=org_id,
            cn_id=cn.id,
            cn_number=cn_number,
            cn_date=cn.cn_date,
            invoice_type=getattr(inv, "invoice_type", "purchase"),
            party_type=cn.party_type,
            party_id=cn.party_id,
            amount=cn.amount,
            created_by=current_user.id,
        )
    except Exception:
        logger.exception("GL posting failed for credit note %s", cn_number)

    return {"id": cn.id, "cn_number": cn_number, "message": "Credit note created"}


@router.post("/credit-notes/{cn_id}/submit")
async def submit_credit_note(
    cn_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_any_role("super_admin", "admin", "accounts_manager")),
):
    """Move credit note from draft → issued (locks amount, posts GL if not yet).

    BUG-FIN-053: previously CNs had no submit/approve workflow.
    """
    cn = (await db.execute(select(CreditNote).where(CreditNote.id == cn_id))).scalar_one_or_none()
    if not cn:
        raise HTTPException(status_code=404, detail="Credit note not found")
    if cn.status != "draft":
        raise HTTPException(status_code=400, detail=f"Credit note is already {cn.status}")
    cn.status = "issued"
    await db.flush()
    return {"success": True, "message": "Credit note submitted"}


@router.post("/credit-notes/{cn_id}/cancel")
async def cancel_credit_note(
    cn_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_any_role("super_admin", "admin", "accounts_manager")),
):
    """Cancel a credit note. Reverses GL JE and restores invoice balance.

    BUG-FIN-053: completes the CN workflow (draft → issued → adjusted/cancelled).
    """
    cn = (await db.execute(select(CreditNote).where(CreditNote.id == cn_id))).scalar_one_or_none()
    if not cn:
        raise HTTPException(status_code=404, detail="Credit note not found")
    if cn.status == "cancelled":
        return {"success": True, "message": "Already cancelled"}

    amount = Decimal(str(cn.amount or 0))
    # Restore invoice balance / paid amount
    if cn.invoice_id:
        inv_res = await db.execute(
            select(Invoice).where(Invoice.id == cn.invoice_id).with_for_update()
        )
        inv = inv_res.scalar_one_or_none()
        if inv:
            inv.paid_amount = max(Decimal("0"), (inv.paid_amount or Decimal("0")) - amount)
            inv.balance_amount = (inv.grand_total or Decimal("0")) - inv.paid_amount
            if inv.balance_amount >= inv.grand_total:
                inv.status = "submitted"
            elif inv.paid_amount > 0:
                inv.status = "partially_paid"

    cn.status = "cancelled"
    await db.flush()

    try:
        from app.services.gl_posting import reverse_journal_entries
        from datetime import datetime as _dt
        org_id = current_user.organization_id or 1
        await reverse_journal_entries(
            db,
            organization_id=org_id,
            reference_type="credit_note",
            reference_id=cn.id,
            reversal_date=_dt.utcnow(),
            narration=f"Reversal: credit note {cn.cn_number} cancelled",
            created_by=current_user.id,
        )
    except Exception:
        logger.exception("GL reversal failed for cancelled credit note %s", cn.cn_number)

    return {"success": True, "message": "Credit note cancelled and reversed"}


# ==================== JOURNAL ENTRIES ====================

@router.get("/journal-entries")
async def list_journal_entries(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    search: str = Query(None),
    status: str = Query(None),
    project_id: int = Query(None),
    db: AsyncSession = Depends(get_db),
    # R-001: read-level RBAC enforcement
    current_user: User = Depends(require_permission("accounts", "view", "journal_entries")),
):
    offset, limit = paginate_params(page, page_size)
    JeCreator = aliased(User, flat=True)
    query = (
        select(
            JournalEntry,
            Project.name.label("project_name"),
            func.concat(JeCreator.first_name, " ", func.coalesce(JeCreator.last_name, "")).label("creator_name"),
        )
        .options(selectinload(JournalEntry.lines).selectinload(JournalEntryLine.account))
        .outerjoin(Project, JournalEntry.project_id == Project.id)
        .outerjoin(JeCreator, JournalEntry.created_by == JeCreator.id)
    )
    count_query = select(func.count(JournalEntry.id))

    if status:
        query = query.where(JournalEntry.status == status)
        count_query = count_query.where(JournalEntry.status == status)
    if project_id:
        query = query.where(JournalEntry.project_id == project_id)
        count_query = count_query.where(JournalEntry.project_id == project_id)

    # BUG-FIN-015 / BUG-FIN-060 (Wave 5): tenant scope. super_admin sees all
    # orgs; everyone else is pinned to their own org. Backfilled rows that
    # are still NULL are visible to super_admin only.
    is_super = any((ur.role and ur.role.code == "super_admin") for ur in (current_user.roles or []))
    if not is_super:
        org_id = current_user.organization_id
        query = query.where(JournalEntry.organization_id == org_id)
        count_query = count_query.where(JournalEntry.organization_id == org_id)

    query = apply_search_filter(query, JournalEntry, search, ["entry_number", "narration"])
    count_query = apply_search_filter(count_query, JournalEntry, search, ["entry_number", "narration"])

    total = (await db.execute(count_query)).scalar()
    result = await db.execute(query.offset(offset).limit(limit).order_by(JournalEntry.id.desc()))
    rows = result.unique().all()
    entries = []
    for row in rows:
        je = row[0]
        data = JournalEntryResponse.model_validate(je)
        data.project_name = row.project_name
        data.creator_name = row.creator_name.strip() if row.creator_name else None
        # Enrich lines with account_name from selectinloaded relationship
        enriched_lines = []
        for line in je.lines:
            line_data = JournalEntryLineResponse.model_validate(line)
            line_data.account_name = line.account.account_name if line.account else None
            enriched_lines.append(line_data)
        data.lines = enriched_lines
        entries.append(data)
    return build_paginated_response(entries, total, page, page_size)


@router.post("/journal-entries", status_code=201)
async def create_journal_entry(
    payload: JournalEntryCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_any_role("super_admin", "admin", "accounts_manager")),
):
    entry_number = await generate_number(db, "accounts", "journal_entry")
    # BUG-FIN-056: use Decimal-aware comparison with a small tolerance — `==`
    # between Decimal and float (or two Decimals from arithmetic chains) can
    # be off by a paise from quantize drift.
    total_debit = sum((Decimal(str(l.debit or 0)) for l in payload.lines), Decimal("0"))
    total_credit = sum((Decimal(str(l.credit or 0)) for l in payload.lines), Decimal("0"))

    if abs(total_debit - total_credit) > Decimal("0.01"):
        raise HTTPException(status_code=400, detail="Total debit must equal total credit")

    je = JournalEntry(
        entry_number=entry_number,
        entry_date=payload.entry_date,
        entry_type=payload.entry_type,
        project_id=payload.project_id,
        reference_type=payload.reference_type,
        reference_id=payload.reference_id,
        total_debit=total_debit,
        total_credit=total_credit,
        narration=payload.narration,
        created_by=current_user.id,
        # Wave 5 — stamp org so list_journal_entries can scope (BUG-FIN-015).
        organization_id=current_user.organization_id,
    )
    db.add(je)
    await db.flush()

    for line in payload.lines:
        jel = JournalEntryLine(
            je_id=je.id, account_id=line.account_id,
            debit=line.debit, credit=line.credit,
            party_type=line.party_type, party_id=line.party_id,
            narration=line.narration,
        )
        db.add(jel)

    await db.flush()
    return {"id": je.id, "entry_number": entry_number, "message": "Journal entry created"}


@router.post("/journal-entries/{je_id}/post")
async def post_journal_entry(
    je_id: int,
    db: AsyncSession = Depends(get_db),
    # BUG-FIN-057: gate posting JEs to accounts managers / admins only.
    current_user: User = Depends(require_any_role("super_admin", "admin", "accounts_manager")),
):
    result = await db.execute(
        select(JournalEntry).options(selectinload(JournalEntry.lines)).where(JournalEntry.id == je_id)
    )
    je = result.scalar_one_or_none()
    if not je:
        raise HTTPException(status_code=404, detail="Journal entry not found")

    # BUG-FIN-059: idempotency — refuse to post a JE that's already posted
    # (or cancelled) so callers can safely retry without duplicating ledger
    # rows.
    if je.status == "posted":
        raise HTTPException(status_code=400, detail="Journal entry is already posted")
    if je.status == "cancelled":
        raise HTTPException(status_code=400, detail="Cannot post a cancelled journal entry")

    # BUG-FIN-058: re-verify balance at post-time. Lines may have been edited
    # after creation; never trust the stored totals.
    line_debit = sum((Decimal(str(l.debit or 0)) for l in je.lines), Decimal("0"))
    line_credit = sum((Decimal(str(l.credit or 0)) for l in je.lines), Decimal("0"))
    if abs(line_debit - line_credit) > Decimal("0.01"):
        raise HTTPException(
            status_code=400,
            detail=f"Journal entry is unbalanced (Dr={line_debit} Cr={line_credit}); cannot post",
        )

    # Post to account ledger
    for line in je.lines:
        al = AccountLedger(
            account_id=line.account_id,
            posting_date=je.entry_date,
            party_type=line.party_type,
            party_id=line.party_id,
            project_id=je.project_id,
            reference_type="journal_entry",
            reference_id=je.id,
            debit=line.debit,
            credit=line.credit,
            balance=Decimal(str(line.debit or 0)) - Decimal(str(line.credit or 0)),
            narration=line.narration or je.narration,
        )
        db.add(al)

    je.status = "posted"
    je.total_debit = line_debit
    je.total_credit = line_credit
    await db.flush()
    return {"success": True, "message": "Journal entry posted"}


@router.post("/journal-entries/{je_id}/reverse")
async def reverse_journal_entry(
    je_id: int,
    payload: dict | None = None,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_any_role("super_admin", "admin", "accounts_manager")),
):
    """Post a reversing JE (mirror debits/credits) for a previously-posted JE.

    BUG-FIN-021: previously there was no first-class JE reversal API.
    Body (optional): {narration, reversal_date}.
    """
    from datetime import datetime as _dt
    body = payload or {}

    je = (await db.execute(
        select(JournalEntry).options(selectinload(JournalEntry.lines)).where(JournalEntry.id == je_id)
    )).scalar_one_or_none()
    if not je:
        raise HTTPException(status_code=404, detail="Journal entry not found")
    if je.status != "posted":
        raise HTTPException(status_code=400, detail="Only posted journal entries can be reversed")
    if not je.lines:
        raise HTTPException(status_code=400, detail="JE has no lines to reverse")

    rev_date_str = body.get("reversal_date")
    rev_date = _dt.utcnow()
    if rev_date_str:
        try:
            rev_date = _dt.fromisoformat(rev_date_str)
        except Exception:
            raise HTTPException(status_code=400, detail="Invalid reversal_date (ISO format)")

    narration = body.get("narration") or f"Reversal of JE {je.entry_number}"

    from app.services.gl_posting import post_journal as _post_journal
    org_id = current_user.organization_id or 1
    mirror_lines = [
        {
            "account_id": l.account_id,
            "debit": Decimal(str(l.credit or 0)),
            "credit": Decimal(str(l.debit or 0)),
            "party_type": l.party_type,
            "party_id": l.party_id,
            "narration": f"REVERSAL: {l.narration or je.narration or ''}".strip(),
        }
        for l in je.lines
    ]
    rev = await _post_journal(
        db,
        organization_id=org_id,
        entry_date=rev_date,
        entry_type="adjustment",
        reference_type="journal_entry_reversal",
        reference_id=je.id,
        narration=narration,
        lines=mirror_lines,
        project_id=je.project_id,
        created_by=current_user.id,
    )
    je.status = "cancelled"
    await db.flush()
    return {
        "success": True,
        "reversal_je_id": rev.id if rev else None,
        "reversal_entry_number": rev.entry_number if rev else None,
    }


# ==================== LEDGER ====================

@router.get("/ledger")
async def get_account_ledger(
    account_id: int = Query(None),
    party_type: str = Query(None),
    party_id: int = Query(None),
    project_id: int = Query(None),
    po_id: int = Query(None),
    search: str = Query(None),
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
    db: AsyncSession = Depends(get_db),
    # R-001: read-level RBAC enforcement
    current_user: User = Depends(require_permission("accounts", "view", "ledger")),
):
    offset, limit = paginate_params(page, page_size)
    LedgerVendor = aliased(Vendor, flat=True)
    query = (
        select(
            AccountLedger,
            ChartOfAccounts.account_name.label("account_name"),
            LedgerVendor.name.label("party_name"),
        )
        .outerjoin(ChartOfAccounts, AccountLedger.account_id == ChartOfAccounts.id)
        .outerjoin(LedgerVendor, and_(AccountLedger.party_type == "vendor", AccountLedger.party_id == LedgerVendor.id))
        .order_by(AccountLedger.posting_date.desc())
    )
    count_query = select(func.count(AccountLedger.id))

    if account_id:
        query = query.where(AccountLedger.account_id == account_id)
        count_query = count_query.where(AccountLedger.account_id == account_id)
    if party_type:
        query = query.where(AccountLedger.party_type == party_type)
        count_query = count_query.where(AccountLedger.party_type == party_type)
    if party_id:
        query = query.where(AccountLedger.party_id == party_id)
        count_query = count_query.where(AccountLedger.party_id == party_id)
    if project_id:
        query = query.where(AccountLedger.project_id == project_id)
        count_query = count_query.where(AccountLedger.project_id == project_id)
    if po_id:
        query = query.where(AccountLedger.po_id == po_id)
        count_query = count_query.where(AccountLedger.po_id == po_id)

    query = apply_search_filter(query, AccountLedger, search, ["narration"])
    count_query = apply_search_filter(count_query, AccountLedger, search, ["narration"])

    total = (await db.execute(count_query)).scalar()
    result = await db.execute(query.offset(offset).limit(limit))
    rows = result.all()
    entries = []
    for row in rows:
        al = row[0]
        data = AccountLedgerResponse.model_validate(al)
        data.account_name = row.account_name
        data.party_name = row.party_name
        entries.append(data)
    return build_paginated_response(entries, total, page, page_size)


# ==================== WAVE 6: COA SEED + MAPPINGS + REPORTS ====================

@router.post("/seed-coa", status_code=200)
async def seed_chart_of_accounts(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_any_role("super_admin", "admin", "accounts_manager")),
):
    """Seed the standard chart of accounts + default GL mappings for the user's org.

    Idempotent — re-running adds only what's missing.
    """
    from app.services.coa_seed import seed_coa_for_org
    org_id = current_user.organization_id or 1
    summary = await seed_coa_for_org(db, organization_id=org_id)
    return {"success": True, "organization_id": org_id, **summary}


@router.get("/account-mappings")
async def list_account_mappings(
    event: str = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    DebitAcc = aliased(ChartOfAccounts, flat=True)
    CreditAcc = aliased(ChartOfAccounts, flat=True)
    org_id = current_user.organization_id or 1
    q = (
        select(
            AccountMapping,
            DebitAcc.account_code.label("debit_code"),
            DebitAcc.account_name.label("debit_name"),
            CreditAcc.account_code.label("credit_code"),
            CreditAcc.account_name.label("credit_name"),
        )
        .outerjoin(DebitAcc, AccountMapping.debit_account_id == DebitAcc.id)
        .outerjoin(CreditAcc, AccountMapping.credit_account_id == CreditAcc.id)
        .where(AccountMapping.organization_id == org_id)
    )
    if event:
        q = q.where(AccountMapping.event == event)
    q = q.order_by(AccountMapping.event, AccountMapping.id)
    result = await db.execute(q)
    rows = []
    for r in result.all():
        m = r[0]
        rows.append({
            "id": m.id,
            "event": m.event,
            "item_category_id": m.item_category_id,
            "warehouse_id": m.warehouse_id,
            "debit_account_id": m.debit_account_id,
            "credit_account_id": m.credit_account_id,
            "debit_code": r.debit_code,
            "debit_name": r.debit_name,
            "credit_code": r.credit_code,
            "credit_name": r.credit_name,
            "is_active": m.is_active,
        })
    return rows


@router.post("/account-mappings", status_code=201)
async def create_account_mapping(
    payload: dict,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_any_role("super_admin", "admin", "accounts_manager")),
):
    # BUG-FIN-162: never silently fall back to org 1 — that pollutes the
    # default tenant with mappings from misconfigured users. Reject if the
    # caller has no org.
    if not current_user.organization_id:
        raise HTTPException(
            status_code=400,
            detail="User has no organization; cannot create account mapping",
        )
    org_id = current_user.organization_id
    m = AccountMapping(
        organization_id=org_id,
        event=payload["event"],
        item_category_id=payload.get("item_category_id"),
        warehouse_id=payload.get("warehouse_id"),
        debit_account_id=payload.get("debit_account_id"),
        credit_account_id=payload.get("credit_account_id"),
        is_active=payload.get("is_active", True),
    )
    db.add(m)
    await db.flush()
    return {"id": m.id, "message": "Mapping created"}


@router.put("/account-mappings/{mapping_id}")
async def update_account_mapping(
    mapping_id: int,
    payload: dict,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_any_role("super_admin", "admin", "accounts_manager")),
):
    result = await db.execute(select(AccountMapping).where(AccountMapping.id == mapping_id))
    m = result.scalar_one_or_none()
    if not m:
        raise HTTPException(status_code=404, detail="Mapping not found")
    for k in ("event", "item_category_id", "warehouse_id", "debit_account_id", "credit_account_id", "is_active"):
        if k in payload:
            setattr(m, k, payload[k])
    await db.flush()
    return {"success": True}


@router.delete("/account-mappings/{mapping_id}")
async def delete_account_mapping(
    mapping_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_any_role("super_admin", "admin", "accounts_manager")),
):
    result = await db.execute(select(AccountMapping).where(AccountMapping.id == mapping_id))
    m = result.scalar_one_or_none()
    if not m:
        raise HTTPException(status_code=404, detail="Mapping not found")
    # BUG-FIN-163: persist an audit-log entry so a deletion can be tracked
    # later (account mappings drive every GL posting — losing one without a
    # trail is a forensic nightmare).
    try:
        from app.models.system import ActivityLog as _AL
        db.add(_AL(
            user_id=current_user.id,
            action="account_mapping_deleted",
            entity_type="account_mapping",
            entity_id=m.id,
            new_values={
                "event": getattr(m, "event", None),
                "item_category_id": getattr(m, "item_category_id", None),
                "warehouse_id": getattr(m, "warehouse_id", None),
                "debit_account_id": getattr(m, "debit_account_id", None),
                "credit_account_id": getattr(m, "credit_account_id", None),
                "organization_id": getattr(m, "organization_id", None),
            },
        ))
    except Exception:
        logger.exception("Failed to write ActivityLog for account_mapping_deleted (id=%s)", mapping_id)
    await db.delete(m)
    await db.flush()
    return {"success": True}


@router.get("/reports/trial-balance")
async def report_trial_balance(
    as_of: str = Query(None),
    db: AsyncSession = Depends(get_db),
    # R-001/R-008: financial reports gated to accounts viewers
    current_user: User = Depends(require_permission("accounts", "view", "reports")),
):
    from app.services.gl_posting import trial_balance
    from datetime import date as _date
    org_id = current_user.organization_id or 1
    as_of_date = None
    if as_of:
        try:
            as_of_date = _date.fromisoformat(as_of)
        except Exception:
            raise HTTPException(status_code=400, detail="Invalid as_of (use YYYY-MM-DD)")
    rows = await trial_balance(db, organization_id=org_id, as_of=as_of_date)
    # BUG-FIN-031: sum via Decimal then quantize so the API totals match
    # the per-row paise; Python sum() on floats accumulates ±0.005 drift.
    from decimal import Decimal as _D, ROUND_HALF_UP as _RHU
    _Q2 = _D("0.01")
    td_dec = sum((_D(str(r["total_debit"])) for r in rows), _D("0")).quantize(_Q2, rounding=_RHU)
    tc_dec = sum((_D(str(r["total_credit"])) for r in rows), _D("0")).quantize(_Q2, rounding=_RHU)
    diff_dec = (td_dec - tc_dec).quantize(_Q2, rounding=_RHU)
    return {
        "as_of": as_of_date.isoformat() if as_of_date else None,
        "rows": rows,
        "totals": {
            "total_debit": float(td_dec),
            "total_credit": float(tc_dec),
            "difference": float(diff_dec),
        },
    }


@router.get("/reports/profit-loss")
async def report_profit_loss(
    from_date: str = Query(...),
    to_date: str = Query(...),
    db: AsyncSession = Depends(get_db),
    # R-001/R-008
    current_user: User = Depends(require_permission("accounts", "view", "reports")),
):
    from app.services.gl_posting import profit_loss
    from datetime import date as _date
    org_id = current_user.organization_id or 1
    try:
        f = _date.fromisoformat(from_date)
        t = _date.fromisoformat(to_date)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid date (use YYYY-MM-DD)")
    return await profit_loss(db, organization_id=org_id, from_date=f, to_date=t)


@router.get("/reports/stock-valuation")
async def report_stock_valuation(
    db: AsyncSession = Depends(get_db),
    # BUG-FIN-157: gate financial stock valuation to accounts/inventory viewers.
    current_user: User = Depends(require_permission("accounts", "view", "reports")),
):
    from app.services.gl_posting import stock_valuation
    org_id = current_user.organization_id or 1
    rows = await stock_valuation(db, organization_id=org_id)
    return {
        "rows": rows,
        "totals": {
            "total_qty": sum(r["total_qty"] for r in rows),
            "total_value": sum(r["total_value"] for r in rows),
        },
    }


@router.get("/reports/balance-sheet")
async def report_balance_sheet(
    as_of: str = Query(None),
    db: AsyncSession = Depends(get_db),
    # R-001/R-008
    current_user: User = Depends(require_permission("accounts", "view", "reports")),
):
    """Group trial-balance rows into Assets / Liabilities / Equity."""
    from app.services.gl_posting import trial_balance
    from datetime import date as _date
    org_id = current_user.organization_id or 1
    as_of_date = None
    if as_of:
        try:
            as_of_date = _date.fromisoformat(as_of)
        except Exception:
            raise HTTPException(status_code=400, detail="Invalid as_of (use YYYY-MM-DD)")
    rows = await trial_balance(db, organization_id=org_id, as_of=as_of_date)
    assets = [r for r in rows if r["account_type"] == "asset" and r["balance"] != 0]
    liabilities = [r for r in rows if r["account_type"] == "liability" and r["balance"] != 0]
    equity = [r for r in rows if r["account_type"] == "equity" and r["balance"] != 0]
    income_total = sum(r["balance"] for r in rows if r["account_type"] == "income")
    expense_total = sum(r["balance"] for r in rows if r["account_type"] == "expense")
    retained_earnings = round(income_total - expense_total, 2)
    return {
        "as_of": as_of_date.isoformat() if as_of_date else None,
        "assets": assets,
        "liabilities": liabilities,
        "equity": equity,
        "totals": {
            "total_assets": round(sum(r["balance"] for r in assets), 2),
            "total_liabilities": round(sum(r["balance"] for r in liabilities), 2),
            "total_equity": round(sum(r["balance"] for r in equity), 2),
            "retained_earnings": retained_earnings,
        },
    }


@router.post("/fiscal-years/{fy_id}/close")
async def close_fiscal_year(
    fy_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_any_role("super_admin", "admin", "accounts_manager")),
):
    """Close a fiscal year: post net income to retained earnings, lock the period.

    BUG-FIN-023: previously fiscal-year close was a flag-flip with no GL
    closing entry; income/expense balances kept showing on subsequent TBs.
    """
    from datetime import datetime as _dt
    org_id = current_user.organization_id or 1
    fy = (await db.execute(
        select(FiscalYear).where(FiscalYear.id == fy_id, FiscalYear.organization_id == org_id)
    )).scalar_one_or_none()
    if not fy:
        raise HTTPException(status_code=404, detail="Fiscal year not found")
    if fy.is_closed:
        return {"success": True, "message": "Already closed"}

    # Compute net P&L for the period
    from app.services.gl_posting import profit_loss, post_journal as _post_journal
    pl = await profit_loss(
        db, organization_id=org_id, from_date=fy.start_date, to_date=fy.end_date,
    )
    net_profit = Decimal(str(pl.get("net_profit") or 0))

    # Look up retained-earnings account (account_code 3010 by convention) and a
    # general "P&L summary" — fall back gracefully if either is missing.
    re_id = (await db.execute(
        select(ChartOfAccounts.id).where(
            ChartOfAccounts.organization_id == org_id,
            ChartOfAccounts.account_code == "3010",
        )
    )).scalar_one_or_none()
    pl_summary_id = (await db.execute(
        select(ChartOfAccounts.id).where(
            ChartOfAccounts.organization_id == org_id,
            ChartOfAccounts.account_code == "3020",  # P&L summary if seeded
        )
    )).scalar_one_or_none()

    if re_id and pl_summary_id and net_profit != 0:
        # Profit: P&L summary Dr / Retained Earnings Cr
        # Loss:   Retained Earnings Dr / P&L summary Cr
        lines = (
            [
                {"account_id": pl_summary_id, "debit": net_profit, "credit": Decimal("0"),
                 "narration": f"Closing entry FY {fy.year_label}"},
                {"account_id": re_id, "debit": Decimal("0"), "credit": net_profit,
                 "narration": f"Closing entry FY {fy.year_label}"},
            ]
            if net_profit > 0 else
            [
                {"account_id": re_id, "debit": -net_profit, "credit": Decimal("0"),
                 "narration": f"Closing entry FY {fy.year_label}"},
                {"account_id": pl_summary_id, "debit": Decimal("0"), "credit": -net_profit,
                 "narration": f"Closing entry FY {fy.year_label}"},
            ]
        )
        try:
            await _post_journal(
                db,
                organization_id=org_id,
                entry_date=fy.end_date,
                entry_type="closing",
                reference_type="fiscal_year",
                reference_id=fy.id,
                narration=f"Year-end closing entries — FY {fy.year_label}",
                lines=lines,
                created_by=current_user.id,
            )
        except Exception:
            logger.exception("Closing JE post failed for FY %s", fy.year_label)

    fy.is_closed = True
    fy.closed_at = _dt.utcnow()
    fy.closed_by = current_user.id
    await db.flush()
    return {
        "success": True,
        "message": f"Fiscal year {fy.year_label} closed",
        "net_profit_posted": float(net_profit),
    }


@router.get("/chart-of-accounts/tree")
async def coa_tree(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Return CoA as a hierarchical tree for UI rendering."""
    org_id = current_user.organization_id or 1
    result = await db.execute(
        select(ChartOfAccounts).where(
            ChartOfAccounts.organization_id == org_id,
            ChartOfAccounts.is_active == True,  # noqa: E712
        ).order_by(ChartOfAccounts.account_code)
    )
    accounts = list(result.scalars().all())
    by_id = {a.id: {
        "id": a.id, "code": a.account_code, "name": a.account_name,
        "type": a.account_type, "group": a.account_group,
        "is_group": a.is_group, "level": a.level, "children": [],
    } for a in accounts}
    roots = []
    for a in accounts:
        node = by_id[a.id]
        if a.parent_id and a.parent_id in by_id:
            by_id[a.parent_id]["children"].append(node)
        else:
            roots.append(node)
    return roots


# ==================== CUSTOMERS (BUG-FIN-074) ====================
# Minimal CRUD for the Customer master so sales-side invoices have a
# normalized party reference instead of free-text. The Customer model
# itself was added in masters; this endpoint is the long-missing API.
from app.models.master import Customer
from pydantic import BaseModel
from typing import Optional


class CustomerIn(BaseModel):
    customer_code: str
    name: str
    contact_person: Optional[str] = None
    email: Optional[str] = None
    phone: Optional[str] = None
    address_line1: Optional[str] = None
    city: Optional[str] = None
    state: Optional[str] = None
    pincode: Optional[str] = None
    gst_number: Optional[str] = None
    credit_limit: Optional[float] = 0
    payment_terms_days: Optional[int] = 30


def _customer_dict(c: Customer) -> dict:
    return {
        "id": c.id,
        "customer_code": c.customer_code,
        "name": c.name,
        "contact_person": c.contact_person,
        "email": c.email,
        "phone": c.phone,
        "address_line1": c.address_line1,
        "city": c.city,
        "state": c.state,
        "pincode": c.pincode,
        "gst_number": c.gst_number,
        "credit_limit": float(c.credit_limit or 0),
        "payment_terms_days": c.payment_terms_days,
        "is_active": c.is_active,
    }


@router.get("/customers")
async def list_customers(
    search: Optional[str] = None,
    is_active: Optional[bool] = None,
    skip: int = 0,
    limit: int = 100,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    stmt = select(Customer)
    if is_active is not None:
        stmt = stmt.where(Customer.is_active == is_active)
    if search:
        like = f"%{search}%"
        stmt = stmt.where(or_(Customer.name.ilike(like), Customer.customer_code.ilike(like)))
    stmt = stmt.order_by(Customer.name).offset(skip).limit(min(limit, 500))
    rows = (await db.execute(stmt)).scalars().all()
    return [_customer_dict(c) for c in rows]


@router.post("/customers", status_code=201)
async def create_customer(
    payload: CustomerIn,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_any_role("super_admin", "admin", "accounts_manager", "sales_manager")),
):
    existing = (await db.execute(
        select(Customer).where(Customer.customer_code == payload.customer_code)
    )).scalar_one_or_none()
    if existing:
        raise HTTPException(status_code=400, detail="Customer code already exists")
    c = Customer(**payload.model_dump())
    db.add(c)
    await db.flush()
    return _customer_dict(c)


@router.get("/customers/{customer_id}")
async def get_customer(
    customer_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    c = (await db.execute(select(Customer).where(Customer.id == customer_id))).scalar_one_or_none()
    if not c:
        raise HTTPException(status_code=404, detail="Customer not found")
    return _customer_dict(c)


@router.put("/customers/{customer_id}")
async def update_customer(
    customer_id: int,
    payload: CustomerIn,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_any_role("super_admin", "admin", "accounts_manager", "sales_manager")),
):
    c = (await db.execute(select(Customer).where(Customer.id == customer_id))).scalar_one_or_none()
    if not c:
        raise HTTPException(status_code=404, detail="Customer not found")
    for k, v in payload.model_dump(exclude_unset=True).items():
        setattr(c, k, v)
    await db.flush()
    return _customer_dict(c)


@router.delete("/customers/{customer_id}")
async def deactivate_customer(
    customer_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_any_role("super_admin", "admin")),
):
    c = (await db.execute(select(Customer).where(Customer.id == customer_id))).scalar_one_or_none()
    if not c:
        raise HTTPException(status_code=404, detail="Customer not found")
    c.is_active = False
    await db.flush()
    return {"success": True, "message": "Customer deactivated"}
