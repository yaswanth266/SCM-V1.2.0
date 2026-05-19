"""Wave 11E — Document lineage endpoint.

Surface:
  GET /lineage/{source_type}/{source_id} → traversal of upstream + downstream docs

Source types supported:
  indent, material_request, purchase_order, goods_receipt_note,
  material_issue, consumption_entry, invoice, payment, purchase_return

Response shape:
  {
    "source": {"type": "indent", "id": 7, "number": "BHSPL/26-27/IND/00007", "status": "approved"},
    "upstream": [...],   # docs that triggered this one
    "downstream": [...], # docs generated FROM this one
  }
"""
from __future__ import annotations
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models.user import User
from app.models.indent import Indent
from app.models.procurement import MaterialRequest, PurchaseOrder
from app.models.grn import GoodsReceiptNote, PutawayOrder
from app.models.issue import MaterialIssue
from app.models.consumption import ConsumptionEntry
from app.models.accounts import Invoice, Payment
from app.models.returns import PurchaseReturn
from app.models.transfer import StockTransfer
from app.models.audit import StockAudit
from app.utils.dependencies import get_current_user


router = APIRouter()


async def _doc_summary(db, type_: str, id_: int) -> Optional[dict]:
    """Return {type, id, number, status} for a doc, or None.

    We deliberately SELECT only id/number/status (not the whole row) so any
    legacy schema drift on unrelated columns cannot break lineage.
    """
    field_map = {
        "indent": (Indent, Indent.indent_number, Indent.status),
        "material_request": (MaterialRequest, MaterialRequest.mr_number, MaterialRequest.status),
        "purchase_order": (PurchaseOrder, PurchaseOrder.po_number, PurchaseOrder.status),
        "goods_receipt_note": (GoodsReceiptNote, GoodsReceiptNote.grn_number, GoodsReceiptNote.status),
        "putaway_order": (PutawayOrder, PutawayOrder.putaway_number, PutawayOrder.status),
        "material_issue": (MaterialIssue, MaterialIssue.issue_number, MaterialIssue.status),
        "consumption_entry": (ConsumptionEntry, ConsumptionEntry.entry_number, ConsumptionEntry.status),
        "invoice": (Invoice, Invoice.invoice_number, Invoice.status),
        "payment": (Payment, Payment.payment_number, Payment.status),
        "purchase_return": (PurchaseReturn, PurchaseReturn.return_number, PurchaseReturn.status),
        # BUG-INV-102: include stock_transfer in lineage map.
        "stock_transfer": (StockTransfer, StockTransfer.transfer_number, StockTransfer.status),
        # BUG-INV-107: include stock_audit / cycle counts so adjustments
        # surface in the lineage UI alongside other inventory documents.
        "stock_audit": (StockAudit, StockAudit.audit_number, StockAudit.status),
    }
    if type_ not in field_map:
        return None
    cls, num_col, status_col = field_map[type_]
    row = (await db.execute(
        select(cls.id, num_col.label("num"), status_col.label("st")).where(cls.id == id_)
    )).first()
    if not row:
        return None
    return {
        "type": type_,
        "id": row.id,
        "number": row.num,
        "status": row.st,
    }


async def _fk_lookup(db, cls, id_col, target_id):
    """Run a single-column FK lookup that's safe against schema drift."""
    if not target_id:
        return None
    row = (await db.execute(select(cls.id).where(id_col == target_id).limit(1))).first()
    return row.id if row else None


async def _ids_by(db, cls, fk_col, fk_val):
    """Return list of cls.id where fk_col == fk_val. Drift-safe."""
    rows = (await db.execute(select(cls.id).where(fk_col == fk_val))).all()
    return [r.id for r in rows]


async def _upstream_for(db, type_: str, id_: int) -> list[dict]:
    """Find documents this one was generated from. Each query selects only the
    needed FK column to avoid loading full models (legacy drift safety)."""
    out: list[dict] = []
    if type_ == "material_request":
        row = (await db.execute(
            select(MaterialRequest.indent_id).where(MaterialRequest.id == id_)
        )).first()
        if row and row.indent_id:
            d = await _doc_summary(db, "indent", row.indent_id)
            if d: out.append(d)
    elif type_ == "purchase_order":
        row = (await db.execute(
            select(PurchaseOrder.mr_id).where(PurchaseOrder.id == id_)
        )).first()
        if row and row.mr_id:
            d = await _doc_summary(db, "material_request", row.mr_id)
            if d: out.append(d)
    elif type_ == "goods_receipt_note":
        row = (await db.execute(
            select(GoodsReceiptNote.po_id).where(GoodsReceiptNote.id == id_)
        )).first()
        if row and row.po_id:
            d = await _doc_summary(db, "purchase_order", row.po_id)
            if d: out.append(d)
    elif type_ == "putaway_order":
        row = (await db.execute(
            select(PutawayOrder.grn_id).where(PutawayOrder.id == id_)
        )).first()
        if row and row.grn_id:
            d = await _doc_summary(db, "goods_receipt_note", row.grn_id)
            if d: out.append(d)
    elif type_ == "material_issue":
        row = (await db.execute(
            select(MaterialIssue.indent_id, MaterialIssue.mr_id).where(MaterialIssue.id == id_)
        )).first()
        if row:
            if row.indent_id:
                d = await _doc_summary(db, "indent", row.indent_id)
                if d: out.append(d)
            if row.mr_id:
                d = await _doc_summary(db, "material_request", row.mr_id)
                if d: out.append(d)
    elif type_ == "consumption_entry":
        row = (await db.execute(
            select(ConsumptionEntry.source_issue_id).where(ConsumptionEntry.id == id_)
        )).first()
        if row and row.source_issue_id:
            d = await _doc_summary(db, "material_issue", row.source_issue_id)
            if d: out.append(d)
    elif type_ == "invoice":
        row = (await db.execute(
            select(Invoice.po_id).where(Invoice.id == id_)
        )).first()
        if row and row.po_id:
            d = await _doc_summary(db, "purchase_order", row.po_id)
            if d: out.append(d)
    elif type_ == "payment":
        row = (await db.execute(
            select(Payment.invoice_id).where(Payment.id == id_)
        )).first()
        if row and row.invoice_id:
            d = await _doc_summary(db, "invoice", row.invoice_id)
            if d: out.append(d)
    elif type_ == "purchase_return":
        row = (await db.execute(
            select(PurchaseReturn.grn_id).where(PurchaseReturn.id == id_)
        )).first()
        if row and row.grn_id:
            d = await _doc_summary(db, "goods_receipt_note", row.grn_id)
            if d: out.append(d)
    return out


async def _downstream_for(db, type_: str, id_: int) -> list[dict]:
    """Find documents generated from this one (drift-safe id-only lookups)."""
    out: list[dict] = []
    if type_ == "indent":
        for mr_id in await _ids_by(db, MaterialRequest, MaterialRequest.indent_id, id_):
            d = await _doc_summary(db, "material_request", mr_id)
            if d: out.append(d)
        for mi_id in await _ids_by(db, MaterialIssue, MaterialIssue.indent_id, id_):
            d = await _doc_summary(db, "material_issue", mi_id)
            if d: out.append(d)
    elif type_ == "material_request":
        for po_id in await _ids_by(db, PurchaseOrder, PurchaseOrder.mr_id, id_):
            d = await _doc_summary(db, "purchase_order", po_id)
            if d: out.append(d)
    elif type_ == "purchase_order":
        for g_id in await _ids_by(db, GoodsReceiptNote, GoodsReceiptNote.po_id, id_):
            d = await _doc_summary(db, "goods_receipt_note", g_id)
            if d: out.append(d)
        for inv_id in await _ids_by(db, Invoice, Invoice.po_id, id_):
            d = await _doc_summary(db, "invoice", inv_id)
            if d: out.append(d)
    elif type_ == "goods_receipt_note":
        for p_id in await _ids_by(db, PutawayOrder, PutawayOrder.grn_id, id_):
            d = await _doc_summary(db, "putaway_order", p_id)
            if d: out.append(d)
        for pr_id in await _ids_by(db, PurchaseReturn, PurchaseReturn.grn_id, id_):
            d = await _doc_summary(db, "purchase_return", pr_id)
            if d: out.append(d)
    elif type_ == "material_issue":
        for ce_id in await _ids_by(db, ConsumptionEntry, ConsumptionEntry.source_issue_id, id_):
            d = await _doc_summary(db, "consumption_entry", ce_id)
            if d: out.append(d)
    elif type_ == "invoice":
        for p_id in await _ids_by(db, Payment, Payment.invoice_id, id_):
            d = await _doc_summary(db, "payment", p_id)
            if d: out.append(d)
    elif type_ == "purchase_return":
        # BUG-INV-103: a purchase_return can be downstream-linked to a debit
        # note / credit-note invoice when the vendor agrees to refund. Surface
        # any Invoice rows that reference this PR via reference_type/id so the
        # lineage chain is bidirectional.
        try:
            inv_rows = (await db.execute(
                select(Invoice.id).where(
                    Invoice.reference_type == "purchase_return",
                    Invoice.reference_id == id_,
                )
            )).all()
            for r in inv_rows:
                d = await _doc_summary(db, "invoice", r[0])
                if d:
                    out.append(d)
        except Exception:
            # Invoice may not have reference_type/id columns on legacy schemas
            pass
    return out


async def _recurse_upstream(db, type_: str, id_: int, depth: int, seen: set) -> list[dict]:
    """BUG-INV-105/106: walk upstream transitively up to `depth` levels so we
    can answer "what is the original source of this document?" — was capped
    at one level and only showed the direct parent."""
    if depth <= 0:
        return []
    direct = await _upstream_for(db, type_, id_)
    out: list[dict] = []
    for d in direct:
        key = (d.get("type"), d.get("id"))
        if key in seen:
            continue
        seen.add(key)
        d["depth"] = (depth)
        out.append(d)
        out.extend(await _recurse_upstream(db, d["type"], d["id"], depth - 1, seen))
    return out


async def _recurse_downstream(db, type_: str, id_: int, depth: int, seen: set) -> list[dict]:
    """Walk downstream transitively up to `depth` levels."""
    if depth <= 0:
        return []
    direct = await _downstream_for(db, type_, id_)
    out: list[dict] = []
    for d in direct:
        key = (d.get("type"), d.get("id"))
        if key in seen:
            continue
        seen.add(key)
        d["depth"] = depth
        out.append(d)
        out.extend(await _recurse_downstream(db, d["type"], d["id"], depth - 1, seen))
    return out


@router.get("/{source_type}/{source_id}")
async def get_lineage(
    source_type: str,
    source_id: int,
    depth: int = 5,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """BUG-INV-104: distinguish between "type unknown" (400) and "id not found"
    (404). The previous single 404 conflated the two and operators couldn't
    tell whether they had typo'd the type or were chasing a deleted document.
    BUG-INV-105: traverse the lineage transitively (not just one level) up to
    `depth` levels in each direction (default 5).
    """
    SUPPORTED_TYPES = {
        "indent", "material_request", "purchase_order", "goods_receipt_note",
        "putaway_order", "material_issue", "consumption_entry",
        "invoice", "payment", "purchase_return", "stock_transfer",
        "stock_audit",
    }
    if source_type not in SUPPORTED_TYPES:
        raise HTTPException(
            status_code=400,
            detail=(
                f"Unsupported source_type '{source_type}'. Supported: "
                + ", ".join(sorted(SUPPORTED_TYPES))
            ),
        )
    src = await _doc_summary(db, source_type, source_id)
    if not src:
        raise HTTPException(
            status_code=404,
            detail=f"{source_type} with id={source_id} not found",
        )

    # Cap depth so a malformed lineage tree can't OOM us.
    depth = max(1, min(int(depth), 10))
    upstream = await _recurse_upstream(db, source_type, source_id, depth, {(source_type, source_id)})
    downstream = await _recurse_downstream(db, source_type, source_id, depth, {(source_type, source_id)})

    return {
        "source": src,
        "upstream": upstream,
        "downstream": downstream,
    }
