"""Wave 11B — Fiscal-year-aware document numbering.

Format: BHSPL/26-27/PO/00001
        ORG  / FY    / TYPE / SEQ

Indian fiscal year: April 1 → March 31. So "26-27" = Apr-2026 to Mar-2027.

This module replaces the simple `generate_number()` from `number_series.py`
with a version that:
  - composes ORG/FY/TYPE/SEQ
  - rolls over the sequence each fiscal year
  - is race-safe via SELECT...FOR UPDATE
"""
from __future__ import annotations
from datetime import date
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from app.models.system import NumberSeries


# Map document_type → readable token used in the number
DOC_TOKEN_MAP = {
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
    "run": "RUN",
    "material_inward": "INW",
    "dispatch_acknowledgement": "ACK",
}

DEFAULT_ORG_PREFIX = "BHSPL"


def current_fiscal_year(today: date | None = None) -> str:
    """Return Indian fiscal year as 'YY-YY' (e.g. '26-27' for Apr 2026 – Mar 2027)."""
    today = today or date.today()
    y = today.year
    if today.month < 4:
        # Jan–Mar → previous fiscal year
        return f"{(y - 1) % 100:02d}-{y % 100:02d}"
    return f"{y % 100:02d}-{(y + 1) % 100:02d}"


async def generate_number_v2(
    db: AsyncSession,
    *,
    module: str,
    document_type: str,
    org_prefix: str = DEFAULT_ORG_PREFIX,
    today: date | None = None,
) -> str:
    """Generate the next document number in BHSPL/26-27/PO/00001 format.

    Each (module, document_type, fiscal_year) gets its own sequence.
    """
    fy = current_fiscal_year(today)
    token = DOC_TOKEN_MAP.get(document_type, document_type[:3].upper())

    # Look up an FY-scoped row (or fall back to a non-FY-scoped row from old code)
    result = await db.execute(
        select(NumberSeries).where(
            NumberSeries.module == module,
            NumberSeries.document_type == document_type,
            NumberSeries.fiscal_year == fy,
        ).with_for_update()
    )
    series = result.scalar_one_or_none()

    if not series:
        series = NumberSeries(
            prefix=token,
            module=module,
            document_type=document_type,
            fiscal_year=fy,
            current_number=0,
            pad_length=5,
            org_prefix=org_prefix,
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
                    NumberSeries.fiscal_year == fy,
                ).with_for_update()
            )
            series = result.scalar_one()

    new_num = (series.current_number or 0) + 1
    series.current_number = new_num
    await db.flush()

    # BUG-PRO-129 fix: pad_length=5 caps at 99,999 documents per FY. We don't
    # truncate — the format expands naturally — but we log a loud warning
    # once we cross 90% of the configured pad capacity so finance can rotate
    # the pad before we silently produce 6-digit numbers in BHSPL/26-27/PO/100000.
    pad = series.pad_length or 5
    try:
        cap = 10 ** pad
        if new_num >= int(cap * 0.9):
            import logging as _logging
            _logging.getLogger(__name__).warning(
                "NumberSeries %s/%s/%s near pad capacity: %d/%d. "
                "Increase NumberSeries.pad_length to avoid layout drift.",
                module, document_type, fy, new_num, cap,
            )
    except Exception:
        pass
    seq = str(new_num).zfill(pad)
    org = series.org_prefix or org_prefix
    if series.format_template:
        # BUG-PRO-132 fix: validate that the configured format_template uses only
        # the four supported tokens. A template with a typo'd token like
        # "{seq_no}" would silently emit the literal string and produce
        # un-parseable document numbers like ``BHSPL/26-27/PO/{seq_no}``.
        tmpl = series.format_template
        # Find every {token} substring and ensure it's known.
        import re as _re
        tokens_in_tmpl = set(_re.findall(r"\{(\w+)\}", tmpl))
        unknown = tokens_in_tmpl - {"org", "fy", "type", "seq"}
        if unknown:
            raise ValueError(
                f"NumberSeries {module}/{document_type} format_template has unknown "
                f"tokens {sorted(unknown)} (allowed: org, fy, type, seq)"
            )
        return (
            tmpl
            .replace("{org}", org)
            .replace("{fy}", fy)
            .replace("{type}", token)
            .replace("{seq}", seq)
        )
    return f"{org}/{fy}/{token}/{seq}"
