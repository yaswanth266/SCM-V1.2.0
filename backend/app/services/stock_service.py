import logging
from decimal import Decimal, ROUND_HALF_UP
from datetime import datetime, date, time, timezone
from typing import Optional
from sqlalchemy import select, and_
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from app.models.stock import StockLedger, StockBalance

logger = logging.getLogger(__name__)


class InsufficientStockError(Exception):
    """Raised when stock would go negative."""
    def __init__(self, item_id: int, warehouse_id: int, available: Decimal, requested: Decimal):
        self.item_id = item_id
        self.warehouse_id = warehouse_id
        self.available = available
        self.requested = requested
        super().__init__(
            f"Insufficient stock for item {item_id} in warehouse {warehouse_id}: "
            f"available={available}, requested={requested}"
        )


class StockValueIntegrityError(Exception):
    """Raised when stock value math goes negative — signals a data-integrity issue
    upstream (wrong rate / corrupt balance) rather than something to silently clamp."""
    pass


async def post_stock_ledger(
    db: AsyncSession,
    item_id: int,
    warehouse_id: int,
    transaction_type: str,
    qty_in: Decimal = Decimal("0"),
    qty_out: Decimal = Decimal("0"),
    rate: Decimal = Decimal("0"),
    bin_id: Optional[int] = None,
    batch_id: Optional[int] = None,
    reference_type: Optional[str] = None,
    reference_id: Optional[int] = None,
    uom_id: Optional[int] = None,
    posting_date: Optional[date] = None,
    created_by: Optional[int] = None,
    allow_negative: bool = False,
) -> StockLedger:
    """Post an entry to the stock ledger and update the stock balance.

    Uses SELECT ... FOR UPDATE to prevent race conditions on concurrent updates.
    Raises InsufficientStockError if stock would go negative (unless allow_negative=True).
    """
    if posting_date is None:
        posting_date = date.today()

    # BUG-INV-042: reject rate < 0. A negative rate would invert the value
    # arithmetic below (qty_in increases stock_value, but a negative rate would
    # *decrease* it — silently corrupting inventory valuation). qty_in/qty_out
    # are also caller-controlled and must be non-negative.
    if rate is not None and Decimal(str(rate)) < 0:
        raise ValueError(f"post_stock_ledger: rate must be >= 0 (got {rate})")
    if qty_in is not None and Decimal(str(qty_in)) < 0:
        raise ValueError(f"post_stock_ledger: qty_in must be >= 0 (got {qty_in})")
    if qty_out is not None and Decimal(str(qty_out)) < 0:
        raise ValueError(f"post_stock_ledger: qty_out must be >= 0 (got {qty_out})")

    # Get current balance with row-level locking to prevent race conditions
    balance = await _get_or_create_balance(db, item_id, warehouse_id, bin_id, batch_id, lock=True)

    # Calculate new balance
    current_qty = balance.total_qty or Decimal("0")
    new_qty = current_qty + qty_in - qty_out

    # Validate no negative stock
    if not allow_negative and new_qty < 0:
        raise InsufficientStockError(
            item_id=item_id,
            warehouse_id=warehouse_id,
            available=current_qty,
            requested=qty_out,
        )

    # BUG-INV-089: centralize expired-batch check on every OUTBOUND move so
    # cycle-count adjustments, stock transfers, audits, and any other caller
    # cannot move expired stock without an explicit `allow_negative=True`
    # override (used by error-correction posts only). Inbound moves are not
    # blocked — we still receive expired batches into a quarantine bin.
    if qty_out > 0 and batch_id is not None and not allow_negative:
        from app.models.warehouse import Batch as _Batch
        b_row = await db.execute(select(_Batch).where(_Batch.id == batch_id))
        b = b_row.scalar_one_or_none()
        if b is not None:
            today = date.today()
            exp = b.expiry_date
            # Batch.expiry_date is DateTime — coerce to date for comparison.
            if exp is not None and hasattr(exp, "date"):
                exp = exp.date()
            if exp is not None and exp < today:
                raise InsufficientStockError(
                    item_id=item_id,
                    warehouse_id=warehouse_id,
                    available=Decimal("0"),
                    requested=qty_out,
                )
            if getattr(b, "status", None) in ("expired", "recalled"):
                raise InsufficientStockError(
                    item_id=item_id,
                    warehouse_id=warehouse_id,
                    available=Decimal("0"),
                    requested=qty_out,
                )

    # Weighted-average costing: outbound is valued at the *current* moving-avg
    # rate (balance.valuation_rate), NOT at whatever rate the caller passed.
    # The caller's `rate` is the inbound cost (PO rate). For outbound moves,
    # using the current balance rate keeps inventory value internally consistent.
    current_rate = balance.valuation_rate or Decimal("0")
    value_in = qty_in * rate
    value_out = qty_out * (current_rate if qty_out > 0 else rate)
    current_value = balance.stock_value or Decimal("0")
    new_value = current_value + value_in - value_out
    if new_value < 0:
        # Negative value while qty stays non-negative means the inputs are bad
        # (wrong rate, corrupted balance, or out-of-order posting). Clamping
        # silently destroys the audit trail — alert loudly. Operators can
        # explicitly post an `allow_negative=True` correction if needed.
        logger.error(
            "Stock value would go negative: item_id=%s warehouse_id=%s "
            "computed_value=%s (current=%s, value_in=%s, value_out=%s, "
            "qty_in=%s, qty_out=%s, rate=%s, current_rate=%s)",
            item_id, warehouse_id, new_value, current_value, value_in, value_out,
            qty_in, qty_out, rate, current_rate,
        )
        if not allow_negative:
            raise StockValueIntegrityError(
                f"Stock value would go negative for item {item_id} in warehouse "
                f"{warehouse_id}: current={current_value}, value_in={value_in}, "
                f"value_out={value_out}. Likely a bad rate or corrupted balance."
            )
        # BUG-INV-040: when the caller opts into allow_negative we still must
        # NOT silently clamp — that hides capital-loss events from finance.
        # Record an ActivityLog entry so the finance team can reconcile.
        clamped_loss = -new_value  # how much value is being silently zeroed
        new_value = Decimal("0")
        try:
            from app.models.system import ActivityLog as _AL
            db.add(_AL(
                user_id=created_by,
                action="stock_value_clamped",
                entity_type="stock_ledger",
                entity_id=None,
                new_values={
                    "item_id": item_id,
                    "warehouse_id": warehouse_id,
                    "transaction_type": transaction_type,
                    "computed_value": str(current_value + value_in - value_out),
                    "clamped_loss": str(clamped_loss),
                    "current_value": str(current_value),
                    "value_in": str(value_in),
                    "value_out": str(value_out),
                    "reference_type": reference_type,
                    "reference_id": reference_id,
                },
            ))
        except Exception:
            logger.exception(
                "Failed to write ActivityLog for clamped stock value (item=%s wh=%s)",
                item_id, warehouse_id,
            )

    # Effective rate for the ledger row: keep caller-supplied for inbound,
    # snap to current weighted-avg for outbound so the audit trail is honest.
    effective_rate = rate if qty_in > 0 else (current_rate if qty_out > 0 else rate)

    # Create ledger entry
    ledger = StockLedger(
        item_id=item_id,
        warehouse_id=warehouse_id,
        bin_id=bin_id,
        batch_id=batch_id,
        transaction_type=transaction_type,
        reference_type=reference_type,
        reference_id=reference_id,
        qty_in=qty_in,
        qty_out=qty_out,
        balance_qty=new_qty,
        uom_id=uom_id,
        rate=effective_rate,
        value_in=value_in,
        value_out=value_out,
        balance_value=new_value,
        posting_date=posting_date,
        posting_time=datetime.now(timezone.utc).time(),
        created_by=created_by,
    )
    db.add(ledger)

    # Update balance
    # BUG-INV-041: re-read reserved_qty / transit_qty from the locked row
    # immediately before computing available_qty so we don't use a value that
    # was mutated by another path in the same transaction (the ORM in-memory
    # attributes can lag a flushed update done elsewhere).
    await db.refresh(balance, attribute_names=["reserved_qty", "transit_qty"])
    balance.total_qty = new_qty
    balance.available_qty = new_qty - (balance.reserved_qty or Decimal("0"))
    balance.stock_value = new_value
    # BUG-INV-039: quantize valuation_rate to 4 decimal places. Without this,
    # repeated inbound/outbound posts compound floating-point-like precision drift
    # (Decimal division produces 28-digit results) and stock_value slowly diverges
    # from valuation_rate * total_qty over thousands of transactions.
    if new_qty > 0:
        balance.valuation_rate = (new_value / new_qty).quantize(
            Decimal("0.0001"), rounding=ROUND_HALF_UP,
        )
    else:
        balance.valuation_rate = Decimal("0")

    await db.flush()

    # ── Fire BRE event so business rules (e.g. auto-reorder) can react. ──
    # BUG-INV-044: wrap the rule evaluation in a SAVEPOINT so any side-effect
    # writes a misconfigured rule made (notifications, status flips, cascading
    # rule actions) get rolled back cleanly on failure — without losing the
    # stock-balance + ledger writes already flushed above. Without the
    # savepoint, a half-applied rule could leave the outer transaction in an
    # inconsistent state that's still able to commit.
    try:
        from app.services.rules_engine import evaluate_rules
        # Pull reorder_level from the master Item so rules like
        # "available_qty <= reorder_level" can use lte_field directly.
        from app.models.master import Item as ItemModel
        item_row = await db.execute(select(ItemModel).where(ItemModel.id == item_id))
        item_obj = item_row.scalar_one_or_none()
        ctx = {
            "item_id": item_id,
            "warehouse_id": warehouse_id,
            "transaction_type": transaction_type,
            "qty_in": float(qty_in),
            "qty_out": float(qty_out),
            "available_qty": float(balance.available_qty or 0),
            "total_qty": float(balance.total_qty or 0),
            "reserved_qty": float(balance.reserved_qty or 0),
            "stock_value": float(balance.stock_value or 0),
            "valuation_rate": float(balance.valuation_rate or 0),
            "batch_id": batch_id,
            "uom_id": uom_id,
            "reference_type": reference_type,
            "reference_id": reference_id,
        }
        if item_obj:
            ctx["item_code"] = item_obj.item_code
            ctx["item_name"] = item_obj.name
            ctx["item_type"] = item_obj.item_type
            ctx["reorder_level"] = float(item_obj.reorder_level or 0)
            # BUG-INV-043: use a sentinel default to detect schema renames. If
            # the attribute is genuinely missing on the model (e.g. it was
            # renamed/dropped during a migration), getattr with default=0 used
            # to silently feed BRE rules zero — auto-reorder rules then never
            # fired. Now we log a warning so the gap is visible.
            _MISSING = object()
            _rq = getattr(item_obj, "reorder_qty", _MISSING)
            if _rq is _MISSING:
                logger.warning(
                    "Item model is missing 'reorder_qty' attr (schema drift?) — BRE will see 0",
                )
                ctx["reorder_qty"] = 0.0
            else:
                ctx["reorder_qty"] = float(_rq or 0)
            _ms = getattr(item_obj, "min_stock_level", _MISSING)
            if _ms is _MISSING:
                logger.warning(
                    "Item model is missing 'min_stock_level' attr (schema drift?) — BRE will see 0",
                )
                ctx["min_stock_level"] = 0.0
            else:
                ctx["min_stock_level"] = float(_ms or 0)
        async with db.begin_nested():
            await evaluate_rules(db, "stock.balance_changed", ctx)
    except Exception as exc:
        logger.exception(
            "BRE evaluation failed after stock post (item=%s wh=%s tx=%s): %s",
            item_id, warehouse_id, transaction_type, exc,
        )

    return ledger


async def _get_or_create_balance(
    db: AsyncSession,
    item_id: int,
    warehouse_id: int,
    bin_id: Optional[int],
    batch_id: Optional[int],
    lock: bool = False,
) -> StockBalance:
    """Get existing stock balance or create a new one.

    When lock=True, uses SELECT ... FOR UPDATE to prevent concurrent modification.
    Race-safe on first-time inserts: if two callers race the create branch and
    one hits a unique-constraint violation, we re-query (the other caller's row
    is now visible) and proceed with the lock-acquiring path.
    """
    conditions = [
        StockBalance.item_id == item_id,
        StockBalance.warehouse_id == warehouse_id,
    ]
    if bin_id is not None:
        conditions.append(StockBalance.bin_id == bin_id)
    else:
        conditions.append(StockBalance.bin_id.is_(None))
    if batch_id is not None:
        conditions.append(StockBalance.batch_id == batch_id)
    else:
        conditions.append(StockBalance.batch_id.is_(None))

    query = select(StockBalance).where(and_(*conditions))
    if lock:
        query = query.with_for_update()

    result = await db.execute(query)
    balance = result.scalar_one_or_none()

    if balance is not None:
        return balance

    # First-time insert path. Use a savepoint so a concurrent insert by
    # another transaction (which hits the unique index first) doesn't poison
    # our outer transaction.
    new_balance = StockBalance(
        item_id=item_id,
        warehouse_id=warehouse_id,
        bin_id=bin_id,
        batch_id=batch_id,
        available_qty=Decimal("0"),
        reserved_qty=Decimal("0"),
        transit_qty=Decimal("0"),
        total_qty=Decimal("0"),
        valuation_rate=Decimal("0"),
        stock_value=Decimal("0"),
    )
    try:
        async with db.begin_nested():
            db.add(new_balance)
            await db.flush()
        # Re-query under lock so the caller gets the locked row, not just the
        # ORM-attached new row (the lock is what serializes concurrent posts).
        if lock:
            result = await db.execute(query)
            locked = result.scalar_one_or_none()
            return locked if locked is not None else new_balance
        return new_balance
    except IntegrityError:
        # Another transaction inserted the same balance row first. Re-query
        # — their row should now be visible (and lockable) to us.
        logger.info(
            "Race detected creating StockBalance(item=%s, wh=%s, bin=%s, batch=%s); re-querying",
            item_id, warehouse_id, bin_id, batch_id,
        )
        result = await db.execute(query)
        existing = result.scalar_one_or_none()
        if existing is None:
            # Truly impossible unless the constraint we tripped wasn't on these
            # cols — re-raise to surface the real error.
            raise
        return existing


async def reserve_stock(
    db: AsyncSession,
    item_id: int,
    warehouse_id: int,
    qty: Decimal,
    bin_id: Optional[int] = None,
    batch_id: Optional[int] = None,
) -> bool:
    """Reserve stock for an order. Returns True if sufficient stock available."""
    if qty < 0:
        raise ValueError(f"reserve_stock qty must be >= 0 (got {qty})")
    if qty == 0:
        return True
    balance = await _get_or_create_balance(db, item_id, warehouse_id, bin_id, batch_id, lock=True)
    available = balance.available_qty or Decimal("0")

    if available < qty:
        return False

    balance.reserved_qty = (balance.reserved_qty or Decimal("0")) + qty
    balance.available_qty = available - qty
    await db.flush()
    return True


async def release_reservation(
    db: AsyncSession,
    item_id: int,
    warehouse_id: int,
    qty: Decimal,
    bin_id: Optional[int] = None,
    batch_id: Optional[int] = None,
) -> None:
    """Release previously reserved stock."""
    if qty < 0:
        raise ValueError(f"release_reservation qty must be >= 0 (got {qty})")
    if qty == 0:
        return
    balance = await _get_or_create_balance(db, item_id, warehouse_id, bin_id, batch_id, lock=True)
    reserved = balance.reserved_qty or Decimal("0")
    release_qty = min(reserved, qty)
    balance.reserved_qty = reserved - release_qty
    balance.available_qty = (balance.available_qty or Decimal("0")) + release_qty
    await db.flush()


async def get_fifo_batches(
    db: AsyncSession,
    item_id: int,
    warehouse_id: int,
    required_qty: Decimal,
) -> list:
    """Get batches in FIFO order for picking. Items without manufacturing_date come last.

    MySQL fix: NULLS LAST is Postgres syntax. We emulate it via
    `ORDER BY (col IS NULL), col` which puts NULLs last in ASC order on MySQL.

    BUG-INV-086 (sister fix): also filter expired/recalled batches out of FIFO.
    """
    from app.models.warehouse import Batch
    today = date.today()
    result = await db.execute(
        select(StockBalance, Batch)
        .outerjoin(Batch, StockBalance.batch_id == Batch.id)
        .where(
            StockBalance.item_id == item_id,
            StockBalance.warehouse_id == warehouse_id,
            StockBalance.available_qty > 0,
            (Batch.id.is_(None))
            | (
                ((Batch.expiry_date.is_(None)) | (Batch.expiry_date >= today))
                & (Batch.status.notin_(["expired", "recalled"]))
            ),
        )
        # BUG-INV-087: add deterministic tiebreakers (Batch.id, then balance id)
        # so two batches with the same manufacturing_date pick in a stable
        # order across queries — without this, two consecutive FIFO calls could
        # pick different batches for the same qty, splitting the picks.
        .order_by(
            Batch.manufacturing_date.is_(None),
            Batch.manufacturing_date.asc(),
            Batch.id.asc(),
            StockBalance.id.asc(),
        )
    )
    rows = result.all()

    picks = []
    remaining = required_qty
    for balance, batch in rows:
        if remaining <= 0:
            break
        pick_qty = min(balance.available_qty, remaining)
        picks.append({
            "batch_id": balance.batch_id,
            "bin_id": balance.bin_id,
            "qty": pick_qty,
        })
        remaining -= pick_qty

    return picks


async def get_fefo_batches(
    db: AsyncSession,
    item_id: int,
    warehouse_id: int,
    required_qty: Decimal,
) -> list:
    """Get batches in FEFO order (First Expiry First Out). Items without expiry come last.

    MySQL fix: NULLS LAST is Postgres syntax — emulate with `(col IS NULL)` first.

    BUG-INV-086: filter out expired batches and explicitly-expired/recalled
    statuses. Previously this returned today-or-earlier expiry batches first,
    so FEFO actively *recommended* expired stock — a patient-safety bug.
    """
    from app.models.warehouse import Batch
    today = date.today()
    result = await db.execute(
        select(StockBalance, Batch)
        .outerjoin(Batch, StockBalance.batch_id == Batch.id)
        .where(
            StockBalance.item_id == item_id,
            StockBalance.warehouse_id == warehouse_id,
            StockBalance.available_qty > 0,
            # Either no batch (non-batched item) or batch must be unexpired AND
            # not flagged expired/recalled.
            (Batch.id.is_(None))
            | (
                ((Batch.expiry_date.is_(None)) | (Batch.expiry_date >= today))
                & (Batch.status.notin_(["expired", "recalled"]))
            ),
        )
        # BUG-INV-087: deterministic tiebreakers for batches with identical
        # expiry dates — without these the order is whatever the DB returns
        # last, which can differ across statements.
        .order_by(
            Batch.expiry_date.is_(None),
            Batch.expiry_date.asc(),
            Batch.id.asc(),
            StockBalance.id.asc(),
        )
    )
    rows = result.all()

    picks = []
    remaining = required_qty
    for balance, batch in rows:
        if remaining <= 0:
            break
        pick_qty = min(balance.available_qty, remaining)
        picks.append({
            "batch_id": balance.batch_id,
            "bin_id": balance.bin_id,
            "qty": pick_qty,
        })
        remaining -= pick_qty

    return picks
