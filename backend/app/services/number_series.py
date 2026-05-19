"""Document number generation.

Wave 11 — delegates to fiscal_numbering.generate_number_v2 which produces
BHSPL/26-27/PO/00001 format and resets sequences each fiscal year.

The legacy implementation (MR-00001 style) is retained as `generate_number_legacy`
for any caller that needs the old format. New code should not call it.
"""
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from app.models.system import NumberSeries
from app.services.fiscal_numbering import generate_number_v2


async def generate_number(db: AsyncSession, module: str, document_type: str) -> str:
    """Generate next number in BHSPL/26-27/PO/00001 format (FY-scoped)."""
    return await generate_number_v2(
        db, module=module, document_type=document_type,
    )


async def generate_number_legacy(db: AsyncSession, module: str, document_type: str) -> str:
    """Legacy MR-00001 style. Retained for compatibility.

    BUG-PRO-130: this function is deprecated and SHOULD NOT be called by new code.
    It remains importable so callers that explicitly opted into the old format
    continue to work, but it logs a loud DeprecationWarning so any accidental
    use surfaces in CI / logs and gets migrated to ``generate_number``.
    """
    import warnings as _warnings
    _warnings.warn(
        "generate_number_legacy is deprecated; use generate_number "
        "(BHSPL/FY/TYPE/SEQ format) instead.",
        DeprecationWarning,
        stacklevel=2,
    )
    result = await db.execute(
        select(NumberSeries).where(
            NumberSeries.module == module,
            NumberSeries.document_type == document_type,
            NumberSeries.fiscal_year.is_(None),
        ).with_for_update()
    )
    series = result.scalar_one_or_none()

    _PREFIX_MAP = {
        "material_request": "MR", "purchase_order": "PO", "purchase_return": "PR",
        "quotation": "QTN", "goods_receipt_note": "GRN", "quality_inspection": "QI",
        "putaway_order": "PUT", "stock_transfer": "STR", "stock_audit": "SA",
        "material_issue": "MI", "gate_pass": "GP", "indent": "IND",
        "consumption_entry": "CON", "invoice": "INV", "payment": "PAY",
        "credit_note": "CN", "journal_entry": "JE", "asset": "AST",
        "sales_order": "SO", "delivery_order": "DO", "dispatch_order": "DSP",
        "picking_order": "PCK", "packing_order": "PAK", "wave_plan": "WV",
        "transport_requirement": "TR", "transport_quotation": "TQ",
        "transport_order": "TO", "material_dispatch_advice": "MDA",
    }

    if not series:
        series = NumberSeries(
            prefix=_PREFIX_MAP.get(document_type, document_type[:3].upper()),
            module=module,
            document_type=document_type,
            current_number=0,
            pad_length=5,
        )
        db.add(series)
        try:
            async with db.begin_nested():
                await db.flush()
        except IntegrityError:
            db.expunge(series)
            result = await db.execute(
                select(NumberSeries).where(
                    NumberSeries.module == module,
                    NumberSeries.document_type == document_type,
                    NumberSeries.fiscal_year.is_(None),
                ).with_for_update()
            )
            series = result.scalar_one()

    new_number = series.current_number + 1
    series.current_number = new_number
    await db.flush()

    formatted = str(new_number).zfill(series.pad_length)
    return f"{series.prefix}-{formatted}"
