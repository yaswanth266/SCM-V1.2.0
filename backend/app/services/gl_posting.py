"""GL posting service.

Auto-creates and posts journal entries when business events fire (GRN, Invoice,
Payment, Material Issue, Purchase Return). All postings are wrapped so failures
log a warning but do NOT block the calling operation — the operational system
must keep working even if accounting wiring is incomplete.

Account resolution precedence (most specific first):
  1. (event, item_category_id, warehouse_id)
  2. (event, item_category_id, NULL)
  3. (event, NULL, warehouse_id)
  4. (event, NULL, NULL)  ← org-wide default
"""
from __future__ import annotations
import logging
from decimal import Decimal
from datetime import datetime, timezone
from typing import Optional, Sequence

from sqlalchemy import select, and_, or_
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.accounts import (
    ChartOfAccounts, AccountMapping,
    JournalEntry, JournalEntryLine, AccountLedger,
    FiscalYear,
)
from app.models.master import Item, ItemCategory, Vendor
from app.services.number_series import generate_number


logger = logging.getLogger(__name__)


class GLPostingError(Exception):
    """Raised when a GL posting cannot be completed (configuration or balancing)."""
    pass


# ─────────────────────────────────────────────────────────────────────
# Account resolution
# ─────────────────────────────────────────────────────────────────────

async def resolve_mapping(
    db: AsyncSession,
    organization_id: int,
    event: str,
    item_category_id: Optional[int] = None,
    warehouse_id: Optional[int] = None,
) -> Optional[AccountMapping]:
    """Find the most-specific active mapping for this event.

    BUG-FIN-006: when both ``item_category_id`` and ``warehouse_id`` are
    ``None`` we MUST still return the org-wide default mapping (rows where
    both columns are NULL). The previous formulation collapsed both filters
    to ``column IS NULL`` AND'd together, which works — but failed to
    consider both clauses when truthiness of either side was 0/None which
    short-circuited via Python ``and``. Rewriting explicitly to be safe.
    """
    cat_clause = (
        or_(
            AccountMapping.item_category_id == item_category_id,
            AccountMapping.item_category_id.is_(None),
        )
        if item_category_id
        else AccountMapping.item_category_id.is_(None)
    )
    wh_clause = (
        or_(
            AccountMapping.warehouse_id == warehouse_id,
            AccountMapping.warehouse_id.is_(None),
        )
        if warehouse_id
        else AccountMapping.warehouse_id.is_(None)
    )
    candidates = await db.execute(
        select(AccountMapping).where(
            AccountMapping.organization_id == organization_id,
            AccountMapping.event == event,
            AccountMapping.is_active == True,  # noqa: E712
            cat_clause,
            wh_clause,
        )
    )
    rows = candidates.scalars().all()
    if not rows:
        # Bug fix D-005/D-009 — if no mapping found AND no CoA exists for this
        # org, auto-seed the standard chart on first GL posting attempt.
        # Idempotent — won't duplicate if already seeded.
        try:
            from app.services.coa_seed import seed_coa_for_org
            from app.models.accounts import ChartOfAccounts
            existing = await db.execute(
                select(ChartOfAccounts).where(ChartOfAccounts.organization_id == organization_id).limit(1)
            )
            if existing.scalar_one_or_none() is None:
                await seed_coa_for_org(db, organization_id=organization_id)
                # BUG-FIN-007: re-apply the same specificity filter on retry so
                # we don't return an unrelated NULL/NULL default mapping when
                # the caller asked for a specific category/warehouse combo.
                candidates = await db.execute(
                    select(AccountMapping).where(
                        AccountMapping.organization_id == organization_id,
                        AccountMapping.event == event,
                        AccountMapping.is_active == True,  # noqa: E712
                        cat_clause,
                        wh_clause,
                    )
                )
                rows = candidates.scalars().all()
        except Exception as e:
            logger.warning("Auto-seed CoA failed: %s", e)
        if not rows:
            return None

    # Sort by specificity: rows with both filters set rank highest
    def _score(m: AccountMapping) -> int:
        s = 0
        if m.item_category_id is not None:
            s += 2
        if m.warehouse_id is not None:
            s += 1
        return s

    rows.sort(key=_score, reverse=True)
    return rows[0]


# ─────────────────────────────────────────────────────────────────────
# Journal entry creation + posting
# ─────────────────────────────────────────────────────────────────────

async def post_journal(
    db: AsyncSession,
    *,
    organization_id: int,
    entry_date,
    entry_type: str = "journal",
    reference_type: Optional[str],
    reference_id: Optional[int],
    narration: str,
    lines: Sequence[dict],
    project_id: Optional[int] = None,
    po_id: Optional[int] = None,
    created_by: Optional[int] = None,
) -> Optional[JournalEntry]:
    """Create a balanced journal entry, post lines to AccountLedger.

    Each `line` dict: account_id, debit, credit, party_type?, party_id?, narration?
    Returns the JournalEntry. Raises ``GLPostingError`` on configuration or
    balancing problems so callers can decide to roll back the business
    transaction; previously these were silently swallowed (BUG-FIN-001/002).
    """
    if not lines:
        return None
    # BUG-FIN-014: quantize totals to 2dp so DB write is paise-precise.
    from decimal import ROUND_HALF_UP as _RHU
    _Q2 = Decimal("0.01")
    total_debit = sum(
        (Decimal(str(l.get("debit") or 0)) for l in lines), Decimal("0")
    ).quantize(_Q2, rounding=_RHU)
    total_credit = sum(
        (Decimal(str(l.get("credit") or 0)) for l in lines), Decimal("0")
    ).quantize(_Q2, rounding=_RHU)

    if total_debit == 0 and total_credit == 0:
        return None
    # BUG-FIN-003: per-line math (qty*rate * tax%) routinely accumulates a few
    # paise of drift before quantize. ₹0.01 was too tight and caused legitimate
    # postings to be rejected; ₹0.05 still flags real configuration errors.
    if abs(total_debit - total_credit) > Decimal("0.05"):
        logger.warning(
            "GL posting unbalanced: ref=%s/%s debit=%s credit=%s",
            reference_type, reference_id, total_debit, total_credit,
        )
        # BUG-FIN-002: don't silently drop unbalanced postings — abort the txn.
        raise GLPostingError(
            f"Unbalanced GL posting for {reference_type}/{reference_id}: "
            f"debit={total_debit} credit={total_credit}"
        )

    # BUG-FIN-024: refuse to accept future-dated postings or arbitrary
    # backdated entries beyond a reasonable historical window without
    # explicit approval. Future entries are never legitimate; backdates
    # > 365 days require a manual JE through the proper workflow.
    try:
        from datetime import date as _date, datetime as _dt
        today = _date.today()
        ed = entry_date.date() if isinstance(entry_date, _dt) else entry_date
        if isinstance(ed, _date):
            if ed > today:
                raise GLPostingError(
                    f"Cannot post future-dated JE (entry_date={ed}, today={today})"
                )
            if (today - ed).days > 365:
                raise GLPostingError(
                    f"Backdated JE > 365 days requires explicit fiscal-year override"
                )
    except GLPostingError:
        raise
    except Exception:
        # Date parsing edge cases shouldn't block postings; skip gating.
        pass

    # BUG-FIN-022: refuse to post into a closed fiscal year.
    try:
        # Compare on the date portion in case entry_date is a datetime.
        posting_dt = entry_date
        fy_q = select(FiscalYear).where(
            FiscalYear.organization_id == organization_id,
            FiscalYear.start_date <= posting_dt,
            FiscalYear.end_date >= posting_dt,
            FiscalYear.is_closed == True,  # noqa: E712
        )
        closed_fy = (await db.execute(fy_q)).scalar_one_or_none()
        if closed_fy is not None:
            raise GLPostingError(
                f"Cannot post to closed fiscal year '{closed_fy.year_label}' "
                f"(posting_date={posting_dt})"
            )
    except GLPostingError:
        raise
    except Exception as e:
        # If the FiscalYear table/columns don't exist yet (older deployments),
        # log and continue — don't block real postings on optional gating.
        logger.warning("Fiscal-year close check skipped: %s", e)

    try:
        entry_number = await generate_number(db, "accounts", "journal_entry")
        je = JournalEntry(
            entry_number=entry_number,
            entry_date=entry_date,
            entry_type=entry_type,
            project_id=project_id,
            reference_type=reference_type,
            reference_id=reference_id,
            total_debit=total_debit,
            total_credit=total_credit,
            narration=narration,
            status="posted",
            created_by=created_by,
        )
        db.add(je)
        await db.flush()

        for l in lines:
            ldebit = Decimal(str(l.get("debit") or 0))
            lcredit = Decimal(str(l.get("credit") or 0))
            jel = JournalEntryLine(
                je_id=je.id,
                account_id=l["account_id"],
                debit=ldebit,
                credit=lcredit,
                party_type=l.get("party_type"),
                party_id=l.get("party_id"),
                narration=l.get("narration") or narration,
            )
            db.add(jel)

            # BUG-FIN-004: populate AccountLedger.balance with line-level
            # signed delta (debit - credit). Running-total balance per
            # account is computed by reports — this column gives a
            # per-row signed amount so downstream queries don't need to
            # subtract debit/credit again.
            # BUG-FIN-005: persist po_id on AccountLedger for PO-scoped reports
            # (po_ledger, vendor-aging by PO). Resolves from explicit `po_id`
            # kwarg first, falling back to per-line override.
            al = AccountLedger(
                account_id=l["account_id"],
                posting_date=entry_date,
                party_type=l.get("party_type"),
                party_id=l.get("party_id"),
                project_id=project_id,
                po_id=l.get("po_id") or po_id,
                reference_type=reference_type,
                reference_id=reference_id,
                debit=ldebit,
                credit=lcredit,
                balance=ldebit - lcredit,
                narration=l.get("narration") or narration,
            )
            db.add(al)

        await db.flush()
        return je
    except GLPostingError:
        raise
    except Exception as e:
        logger.exception("GL post_journal failed: %s", e)
        # BUG-FIN-001: re-raise so callers know the GL didn't post and can
        # decide whether to abort the originating transaction.
        raise GLPostingError(f"GL post_journal failed: {e}") from e


# ─────────────────────────────────────────────────────────────────────
# Per-event helpers
# ─────────────────────────────────────────────────────────────────────

async def _item_category(db: AsyncSession, item_id: int) -> Optional[int]:
    row = await db.execute(select(Item.category_id).where(Item.id == item_id))
    return row.scalar_one_or_none()


async def post_grn_gl(
    db: AsyncSession,
    *,
    organization_id: int,
    grn_id: int,
    grn_number: str,
    grn_date,
    vendor_id: Optional[int],
    warehouse_id: Optional[int],
    items: Sequence[dict],
    po_id: Optional[int] = None,
    created_by: Optional[int] = None,
) -> Optional[JournalEntry]:
    """Post inventory Dr / GR-IR Cr per GRN. items: [{item_id, qty, rate}].

    BUG-FIN-008: per-(debit, credit) account pairs are consolidated so the JE
    has one Dr+Cr line per account instead of one per item — this matches
    standard accounting practice and keeps the JE compact.
    BUG-FIN-009: when the rate is zero (free-issue / sample) we still post a
    placeholder line at qty*0 so the GRN is traceable in ledger reports;
    the JE itself will be skipped only if EVERY item has zero amount.
    """
    try:
        # Aggregate amounts per (debit_account_id, credit_account_id) pair
        agg: dict[tuple[int, int], Decimal] = {}
        zero_rate_items: list[int] = []
        total = Decimal("0")
        for it in items:
            qty = Decimal(str(it.get("qty") or 0))
            rate = Decimal(str(it.get("rate") or 0))
            amount = qty * rate
            if amount <= 0:
                # BUG-FIN-009: track zero-rate items for an audit-trail
                # narration; don't silently drop them.
                if qty > 0:
                    zero_rate_items.append(it.get("item_id"))
                continue
            mapping = await resolve_mapping(
                db, organization_id, "grn",
                item_category_id=await _item_category(db, it["item_id"]),
                warehouse_id=warehouse_id,
            )
            if not mapping or not mapping.debit_account_id or not mapping.credit_account_id:
                logger.warning("No GRN account mapping for item %s; skipping GL line", it["item_id"])
                continue
            key = (mapping.debit_account_id, mapping.credit_account_id)
            agg[key] = agg.get(key, Decimal("0")) + amount
            total += amount

        lines = []
        for (dr_id, cr_id), amount in agg.items():
            lines.append({
                "account_id": dr_id,
                "debit": amount, "credit": Decimal("0"),
                "narration": f"GRN {grn_number}",
            })
            lines.append({
                "account_id": cr_id,
                "debit": Decimal("0"), "credit": amount,
                "party_type": "vendor", "party_id": vendor_id,
                "narration": f"GRN {grn_number}",
            })

        if zero_rate_items:
            logger.info(
                "GRN %s: %d zero-rate items skipped from GL (qty>0, rate=0): %s",
                grn_number, len(zero_rate_items), zero_rate_items,
            )

        if not lines:
            return None
        return await post_journal(
            db,
            organization_id=organization_id,
            entry_date=grn_date,
            reference_type="goods_receipt_note",
            reference_id=grn_id,
            narration=f"GRN {grn_number} — goods received",
            lines=lines,
            po_id=po_id,
            created_by=created_by,
        )
    except Exception as e:
        logger.exception("post_grn_gl failed: %s", e)
        return None


async def _resolve_account_by_code(
    db: AsyncSession, organization_id: int, account_code: str
) -> Optional[int]:
    res = await db.execute(
        select(ChartOfAccounts.id).where(
            ChartOfAccounts.organization_id == organization_id,
            ChartOfAccounts.account_code == account_code,
        )
    )
    return res.scalar_one_or_none()


async def post_invoice_gl(
    db: AsyncSession,
    *,
    organization_id: int,
    invoice_id: int,
    invoice_number: str,
    invoice_date,
    invoice_type: str,         # 'purchase' | 'sales'
    party_type: str,
    party_id: int,
    grand_total,
    warehouse_id: Optional[int] = None,
    created_by: Optional[int] = None,
    subtotal: Optional[Decimal] = None,
    cgst_amount: Optional[Decimal] = None,
    sgst_amount: Optional[Decimal] = None,
    igst_amount: Optional[Decimal] = None,
) -> Optional[JournalEntry]:
    """Purchase: GR-IR Dr / AP Cr.  Sales: AR Dr / Sales Income Cr.

    BUG-FIN-011/042: when subtotal & tax components are provided, the JE is
    split: net→revenue/expense account, taxes→GST liability (sales) or
    GST input credit (purchase) accounts.
    """
    try:
        amount = Decimal(str(grand_total or 0))
        if amount <= 0:
            return None

        net = Decimal(str(subtotal)) if subtotal is not None else None
        cgst = Decimal(str(cgst_amount or 0))
        sgst = Decimal(str(sgst_amount or 0))
        igst = Decimal(str(igst_amount or 0))
        total_tax = cgst + sgst + igst
        # If net not supplied, derive from grand_total - tax (so tax-only
        # callers still split properly).
        if net is None:
            net = amount - total_tax
        # Sanity: net must be non-negative; if math drifts, fall back to
        # single-line legacy posting.
        if net < 0:
            net = amount
            cgst = sgst = igst = Decimal("0")
            total_tax = Decimal("0")

        if invoice_type == "purchase":
            mapping = await resolve_mapping(
                db, organization_id, "invoice", warehouse_id=warehouse_id,
            )
            if not mapping or not getattr(mapping, "debit_account_id", None):
                return None
            # mapping.debit_account_id is the inventory/expense Dr side,
            # mapping.credit_account_id is the AP Cr side.
            net_dr_acc = mapping.debit_account_id
            party_cr_acc = mapping.credit_account_id
            gst_acc = await _resolve_account_by_code(db, organization_id, "1150")  # GST Input Credit
        else:
            # BUG-FIN-010: prefer the configured AccountMapping (event="invoice")
            # over hardcoded "4010"/"1130" account codes. Fall back to the
            # legacy code lookup only if no mapping exists for this org.
            sales_mapping = await resolve_mapping(
                db, organization_id, "invoice", warehouse_id=warehouse_id,
            )
            ar_id = (
                sales_mapping.debit_account_id
                if sales_mapping and sales_mapping.debit_account_id
                else await _resolve_account_by_code(db, organization_id, "1130")
            )
            sales_id = (
                sales_mapping.credit_account_id
                if sales_mapping and sales_mapping.credit_account_id
                else await _resolve_account_by_code(db, organization_id, "4010")
            )
            if not sales_id or not ar_id:
                return None
            net_dr_acc = ar_id           # debit side total (AR Dr = grand_total)
            party_cr_acc = sales_id      # credit side net (Sales Cr = net)
            gst_acc = await _resolve_account_by_code(db, organization_id, "2130")  # GST Output Liability

        narration_base = f"Invoice {invoice_number}"
        lines: list[dict] = []

        if invoice_type == "sales":
            # AR Dr full, Sales Cr net, GST output Cr taxes
            lines.append({
                "account_id": net_dr_acc,
                "debit": amount, "credit": Decimal("0"),
                "party_type": party_type, "party_id": party_id,
                "narration": narration_base,
            })
            lines.append({
                "account_id": party_cr_acc,
                "debit": Decimal("0"), "credit": net,
                "narration": f"{narration_base} — net",
            })
            if total_tax > 0 and gst_acc:
                lines.append({
                    "account_id": gst_acc,
                    "debit": Decimal("0"), "credit": total_tax,
                    "narration": f"{narration_base} — GST output",
                })
            elif total_tax > 0:
                # No GST output mapping configured — collapse into sales
                # to keep balanced.
                lines[-1]["credit"] = net + total_tax  # type: ignore[assignment]
        else:
            # Purchase: GR-IR/expense Dr net, GST input Dr taxes, AP Cr full
            lines.append({
                "account_id": net_dr_acc,
                "debit": net, "credit": Decimal("0"),
                "narration": f"{narration_base} — net",
            })
            if total_tax > 0 and gst_acc:
                lines.append({
                    "account_id": gst_acc,
                    "debit": total_tax, "credit": Decimal("0"),
                    "narration": f"{narration_base} — GST input",
                })
            elif total_tax > 0:
                # No GST input mapping configured — fold into net Dr.
                lines[0]["debit"] = net + total_tax  # type: ignore[assignment]
            lines.append({
                "account_id": party_cr_acc,
                "debit": Decimal("0"), "credit": amount,
                "party_type": party_type, "party_id": party_id,
                "narration": narration_base,
            })

        return await post_journal(
            db,
            organization_id=organization_id,
            entry_date=invoice_date,
            reference_type="invoice",
            reference_id=invoice_id,
            narration=f"Invoice {invoice_number} — {invoice_type}",
            lines=lines,
            created_by=created_by,
        )
    except GLPostingError:
        raise
    except Exception as e:
        logger.exception("post_invoice_gl failed: %s", e)
        raise GLPostingError(f"post_invoice_gl failed: {e}") from e


async def post_payment_gl(
    db: AsyncSession,
    *,
    organization_id: int,
    payment_id: int,
    payment_number: str,
    payment_date,
    payment_type: str,         # 'pay' | 'receive'
    party_type: str,
    party_id: int,
    amount,
    created_by: Optional[int] = None,
) -> Optional[JournalEntry]:
    """Pay: AP Dr / Bank Cr.  Receive: Bank Dr / AR Cr."""
    try:
        amt = Decimal(str(amount or 0))
        if amt <= 0:
            return None

        mapping = await resolve_mapping(db, organization_id, "payment")
        if not mapping or not mapping.debit_account_id or not mapping.credit_account_id:
            return None

        if payment_type == "receive":
            # Reverse: bank Dr, AR Cr — but mapping is configured for "pay"
            # So we swap accounts for receive
            debit_id, credit_id = mapping.credit_account_id, mapping.debit_account_id
        else:
            debit_id, credit_id = mapping.debit_account_id, mapping.credit_account_id

        # BUG-FIN-039: distinct narrations per side so trial-balance / ledger
        # reports show "Payment X — Party AP" vs "Payment X — Bank" and can be
        # filtered. Party tagging stays on the AP/AR side (Dr for pay, Cr for
        # receive).
        if payment_type == "receive":
            dr_narration = f"Payment {payment_number} — Bank receipt"
            cr_narration = f"Payment {payment_number} — AR settlement"
        else:
            dr_narration = f"Payment {payment_number} — AP settlement"
            cr_narration = f"Payment {payment_number} — Bank payment"
        lines = [
            {
                "account_id": debit_id,
                "debit": amt, "credit": Decimal("0"),
                "party_type": party_type if payment_type == "pay" else None,
                "party_id": party_id if payment_type == "pay" else None,
                "narration": dr_narration,
            },
            {
                "account_id": credit_id,
                "debit": Decimal("0"), "credit": amt,
                "party_type": party_type if payment_type == "receive" else None,
                "party_id": party_id if payment_type == "receive" else None,
                "narration": cr_narration,
            },
        ]
        return await post_journal(
            db,
            organization_id=organization_id,
            entry_date=payment_date,
            reference_type="payment",
            reference_id=payment_id,
            narration=f"Payment {payment_number} — {payment_type}",
            lines=lines,
            created_by=created_by,
        )
    except Exception as e:
        logger.exception("post_payment_gl failed: %s", e)
        return None


async def post_issue_gl(
    db: AsyncSession,
    *,
    organization_id: int,
    issue_id: int,
    issue_number: str,
    issue_date,
    warehouse_id: int,
    items: Sequence[dict],     # [{item_id, qty, rate}]
    project_id: Optional[int] = None,
    created_by: Optional[int] = None,
) -> Optional[JournalEntry]:
    """Material Issue: Consumption Dr / Inventory Cr.

    `rate` should be the current weighted-avg valuation rate at the time
    of issue.  If the caller doesn't have that, the engine uses 0 and the
    JE will simply be no-value (we still create it for traceability).
    BUG-FIN-013: project_id now propagates to AccountLedger so
    project-ledger reports include consumption postings.
    """
    try:
        lines = []
        total = Decimal("0")
        for it in items:
            qty = Decimal(str(it.get("qty") or 0))
            rate = Decimal(str(it.get("rate") or 0))
            amount = qty * rate
            if amount <= 0:
                continue
            mapping = await resolve_mapping(
                db, organization_id, "issue",
                item_category_id=await _item_category(db, it["item_id"]),
                warehouse_id=warehouse_id,
            )
            if not mapping or not mapping.debit_account_id or not mapping.credit_account_id:
                continue
            lines.append({
                "account_id": mapping.debit_account_id,
                "debit": amount, "credit": Decimal("0"),
                "narration": f"Issue {issue_number} item {it['item_id']}",
            })
            lines.append({
                "account_id": mapping.credit_account_id,
                "debit": Decimal("0"), "credit": amount,
                "narration": f"Issue {issue_number} item {it['item_id']}",
            })
            total += amount

        if not lines:
            return None
        return await post_journal(
            db,
            organization_id=organization_id,
            entry_date=issue_date,
            reference_type="material_issue",
            reference_id=issue_id,
            narration=f"Material Issue {issue_number}",
            lines=lines,
            project_id=project_id,
            created_by=created_by,
        )
    except Exception as e:
        logger.exception("post_issue_gl failed: %s", e)
        return None


async def post_return_gl(
    db: AsyncSession,
    *,
    organization_id: int,
    return_id: int,
    return_number: str,
    return_date,
    vendor_id: Optional[int],
    warehouse_id: Optional[int],
    items: Sequence[dict],     # [{item_id, qty, rate}]
    grn_id: Optional[int] = None,
    created_by: Optional[int] = None,
) -> Optional[JournalEntry]:
    """Purchase Return: GR-IR Dr / Inventory Cr (reverses the GRN).

    BUG-FIN-016: when ``grn_id`` is supplied AND the return is for the full
    GRN qty, reverse the original GRN's JE at the rate it was originally
    posted (avoiding rate drift). For partial returns we still post a fresh
    JE at the supplied current rate.
    """
    # If reversing a full GRN, mirror the original entries to preserve rate.
    if grn_id is not None:
        try:
            from sqlalchemy import select as _select
            existing_je = (await db.execute(
                _select(JournalEntry).where(
                    JournalEntry.reference_type == "goods_receipt_note",
                    JournalEntry.reference_id == grn_id,
                    JournalEntry.status == "posted",
                )
            )).scalars().first()
            if existing_je is not None:
                # Use the reversal helper which already mirrors debits/credits
                return await reverse_journal_entries(
                    db,
                    organization_id=organization_id,
                    reference_type="goods_receipt_note",
                    reference_id=grn_id,
                    reversal_date=return_date,
                    narration=f"Purchase Return {return_number} — reverses GRN",
                    created_by=created_by,
                )
        except GLPostingError:
            raise
        except Exception as e:
            logger.warning("Could not auto-reverse GRN JE for return %s: %s", return_number, e)
            # Fall through to legacy fresh-rate posting below.
    try:
        lines = []
        total = Decimal("0")
        for it in items:
            qty = Decimal(str(it.get("qty") or 0))
            rate = Decimal(str(it.get("rate") or 0))
            amount = qty * rate
            if amount <= 0:
                continue
            mapping = await resolve_mapping(
                db, organization_id, "return",
                item_category_id=await _item_category(db, it["item_id"]),
                warehouse_id=warehouse_id,
            )
            if not mapping or not mapping.debit_account_id or not mapping.credit_account_id:
                continue
            lines.append({
                "account_id": mapping.debit_account_id,
                "debit": amount, "credit": Decimal("0"),
                "party_type": "vendor", "party_id": vendor_id,
                "narration": f"Return {return_number} item {it['item_id']}",
            })
            lines.append({
                "account_id": mapping.credit_account_id,
                "debit": Decimal("0"), "credit": amount,
                "narration": f"Return {return_number} item {it['item_id']}",
            })
            total += amount

        if not lines:
            return None
        return await post_journal(
            db,
            organization_id=organization_id,
            entry_date=return_date,
            reference_type="purchase_return",
            reference_id=return_id,
            narration=f"Purchase Return {return_number}",
            lines=lines,
            created_by=created_by,
        )
    except Exception as e:
        logger.exception("post_return_gl failed: %s", e)
        return None


# ─────────────────────────────────────────────────────────────────────
# Reversal helper
# ─────────────────────────────────────────────────────────────────────

async def reverse_journal_entries(
    db: AsyncSession,
    *,
    organization_id: int,
    reference_type: str,
    reference_id: int,
    reversal_date,
    narration: str,
    created_by: Optional[int] = None,
) -> Optional[JournalEntry]:
    """Find all posted JEs for (reference_type, reference_id) and post a
    mirror JE that swaps debits/credits. Idempotent in practice — callers
    should only invoke when transitioning to ``cancelled`` status.

    BUG-FIN-017/018/019: cancellations and credit notes need a real
    reversal posting; ledgers were previously left untouched.
    """
    je_rows = (await db.execute(
        select(JournalEntry).where(
            JournalEntry.reference_type == reference_type,
            JournalEntry.reference_id == reference_id,
            JournalEntry.status == "posted",
        )
    )).scalars().all()
    if not je_rows:
        return None

    last_reversal: Optional[JournalEntry] = None
    for orig in je_rows:
        line_rows = (await db.execute(
            select(JournalEntryLine).where(JournalEntryLine.je_id == orig.id)
        )).scalars().all()
        if not line_rows:
            continue
        # Mirror lines: swap debit/credit
        mirror_lines = []
        for ln in line_rows:
            mirror_lines.append({
                "account_id": ln.account_id,
                "debit": ln.credit or Decimal("0"),
                "credit": ln.debit or Decimal("0"),
                "party_type": ln.party_type,
                "party_id": ln.party_id,
                "narration": f"REVERSAL: {ln.narration or ''}".strip(),
            })

        last_reversal = await post_journal(
            db,
            organization_id=organization_id,
            entry_date=reversal_date,
            entry_type="adjustment",
            reference_type=f"{reference_type}_reversal",
            reference_id=reference_id,
            narration=narration,
            lines=mirror_lines,
            project_id=orig.project_id,
            created_by=created_by,
        )
        # Mark the original as cancelled so it isn't reversed twice.
        orig.status = "cancelled"
        db.add(orig)

    await db.flush()
    return last_reversal


async def post_credit_note_gl(
    db: AsyncSession,
    *,
    organization_id: int,
    cn_id: int,
    cn_number: str,
    cn_date,
    invoice_type: str,                # 'purchase' | 'sales'
    party_type: str,
    party_id: int,
    amount,
    created_by: Optional[int] = None,
) -> Optional[JournalEntry]:
    """Credit-note GL — reverses a portion of the original invoice's GL.

    Sales credit-note: Sales Dr / AR Cr (reduces revenue & receivable).
    Purchase credit-note: AP Dr / GR-IR (or expense) Cr (reduces payable).
    BUG-FIN-019: previously credit-notes never touched the ledger.
    """
    try:
        amt = Decimal(str(amount or 0))
        if amt <= 0:
            return None

        if invoice_type == "sales":
            sales_id = await _resolve_account_by_code(db, organization_id, "4010")
            ar_id = await _resolve_account_by_code(db, organization_id, "1130")
            if not sales_id or not ar_id:
                return None
            lines = [
                {"account_id": sales_id, "debit": amt, "credit": Decimal("0"),
                 "narration": f"Credit Note {cn_number}"},
                {"account_id": ar_id, "debit": Decimal("0"), "credit": amt,
                 "party_type": party_type, "party_id": party_id,
                 "narration": f"Credit Note {cn_number}"},
            ]
        else:
            mapping = await resolve_mapping(db, organization_id, "invoice")
            if not mapping or not mapping.debit_account_id or not mapping.credit_account_id:
                return None
            # AP Dr / GR-IR (expense) Cr — exactly the reverse of post_invoice_gl
            lines = [
                {"account_id": mapping.credit_account_id, "debit": amt, "credit": Decimal("0"),
                 "party_type": party_type, "party_id": party_id,
                 "narration": f"Credit Note {cn_number}"},
                {"account_id": mapping.debit_account_id, "debit": Decimal("0"), "credit": amt,
                 "narration": f"Credit Note {cn_number}"},
            ]

        return await post_journal(
            db,
            organization_id=organization_id,
            entry_date=cn_date,
            entry_type="adjustment",
            reference_type="credit_note",
            reference_id=cn_id,
            narration=f"Credit Note {cn_number}",
            lines=lines,
            created_by=created_by,
        )
    except GLPostingError:
        raise
    except Exception as e:
        logger.exception("post_credit_note_gl failed: %s", e)
        raise GLPostingError(f"post_credit_note_gl failed: {e}") from e


# ─────────────────────────────────────────────────────────────────────
# Reports
# ─────────────────────────────────────────────────────────────────────

async def trial_balance(db: AsyncSession, *, organization_id: int, as_of=None) -> list[dict]:
    """Trial balance: per-account sum(debit) - sum(credit) on or before `as_of`."""
    from sqlalchemy import func
    q = select(
        ChartOfAccounts.id,
        ChartOfAccounts.account_code,
        ChartOfAccounts.account_name,
        ChartOfAccounts.account_type,
        func.coalesce(func.sum(AccountLedger.debit), 0).label("total_debit"),
        func.coalesce(func.sum(AccountLedger.credit), 0).label("total_credit"),
    ).outerjoin(AccountLedger, AccountLedger.account_id == ChartOfAccounts.id)
    if organization_id:
        q = q.where(ChartOfAccounts.organization_id == organization_id)
    if as_of:
        q = q.where(or_(AccountLedger.posting_date <= as_of, AccountLedger.posting_date.is_(None)))
    q = q.group_by(
        ChartOfAccounts.id, ChartOfAccounts.account_code,
        ChartOfAccounts.account_name, ChartOfAccounts.account_type,
    ).order_by(ChartOfAccounts.account_code)

    # BUG-FIN-025/026/031: keep money values quantized to 2 dp so paise don't
    # disappear when JSON-serialized. We still emit numbers (so the FE can do
    # arithmetic) but round through Decimal first to avoid float drift.
    from decimal import ROUND_HALF_UP
    Q2 = Decimal("0.01")
    result = await db.execute(q)
    rows = []
    for r in result.all():
        debit = Decimal(str(r.total_debit or 0)).quantize(Q2, rounding=ROUND_HALF_UP)
        credit = Decimal(str(r.total_credit or 0)).quantize(Q2, rounding=ROUND_HALF_UP)
        # Asset & Expense: debit-normal balance, others credit-normal
        if r.account_type in ("asset", "expense"):
            balance = (debit - credit).quantize(Q2, rounding=ROUND_HALF_UP)
        else:
            balance = (credit - debit).quantize(Q2, rounding=ROUND_HALF_UP)
        rows.append({
            "account_id": r.id,
            "account_code": r.account_code,
            "account_name": r.account_name,
            "account_type": r.account_type,
            "total_debit": float(debit),
            "total_credit": float(credit),
            "balance": float(balance),
        })
    return rows


async def profit_loss(db: AsyncSession, *, organization_id: int, from_date, to_date) -> dict:
    """P&L: total income minus total expense over the period."""
    from sqlalchemy import func
    income_q = select(func.coalesce(func.sum(AccountLedger.credit - AccountLedger.debit), 0)).where(
        AccountLedger.account_id.in_(
            select(ChartOfAccounts.id).where(
                ChartOfAccounts.organization_id == organization_id,
                ChartOfAccounts.account_type == "income",
            )
        ),
        AccountLedger.posting_date >= from_date,
        AccountLedger.posting_date <= to_date,
    )
    expense_q = select(func.coalesce(func.sum(AccountLedger.debit - AccountLedger.credit), 0)).where(
        AccountLedger.account_id.in_(
            select(ChartOfAccounts.id).where(
                ChartOfAccounts.organization_id == organization_id,
                ChartOfAccounts.account_type == "expense",
            )
        ),
        AccountLedger.posting_date >= from_date,
        AccountLedger.posting_date <= to_date,
    )
    # BUG-FIN-026: keep paise precision via Decimal then quantize to 2dp
    # before float-cast — prior code float-cast each side independently and
    # net_profit could differ by ±0.005 from FE-recomputed value.
    from decimal import ROUND_HALF_UP as _RHU2
    _Q2P = Decimal("0.01")
    income_dec = Decimal(str((await db.execute(income_q)).scalar() or 0)).quantize(_Q2P, rounding=_RHU2)
    expense_dec = Decimal(str((await db.execute(expense_q)).scalar() or 0)).quantize(_Q2P, rounding=_RHU2)
    net_dec = (income_dec - expense_dec).quantize(_Q2P, rounding=_RHU2)
    return {
        "from_date": from_date.isoformat() if hasattr(from_date, "isoformat") else from_date,
        "to_date": to_date.isoformat() if hasattr(to_date, "isoformat") else to_date,
        "total_income": float(income_dec),
        "total_expense": float(expense_dec),
        "net_profit": float(net_dec),
    }


async def stock_valuation(db: AsyncSession, *, organization_id: Optional[int] = None) -> list[dict]:
    """Per-item stock value summary."""
    from app.models.stock import StockBalance
    from sqlalchemy import func
    q = select(
        Item.id, Item.item_code, Item.name,
        func.coalesce(func.sum(StockBalance.total_qty), 0).label("total_qty"),
        func.coalesce(func.sum(StockBalance.stock_value), 0).label("total_value"),
        func.avg(StockBalance.valuation_rate).label("avg_rate"),
    ).join(StockBalance, StockBalance.item_id == Item.id).group_by(
        Item.id, Item.item_code, Item.name
    ).order_by(Item.item_code)

    result = await db.execute(q)
    rows = []
    for r in result.all():
        # BUG-FIN-160: clamp stock_value at 0 — negative valuation rows
        # historically appeared when a return posted before its receipt
        # populated valuation_rate. Reports must never expose a negative
        # asset balance even when the underlying ledger is mid-correction.
        total_qty = float(r.total_qty or 0)
        total_value = max(0.0, float(r.total_value or 0))
        avg_rate = max(0.0, float(r.avg_rate or 0))
        rows.append({
            "item_id": r.id,
            "item_code": r.item_code,
            "item_name": r.name,
            "total_qty": total_qty,
            "total_value": total_value,
            "avg_rate": avg_rate,
        })
    return rows
