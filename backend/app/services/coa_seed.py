"""Default Chart of Accounts seed for an Indian healthcare/SCM organization.

Standard Indian accounting flavor (Tally-style codes), with healthcare-specific
sub-accounts (Pharmacy Stock, Medical Consumables, etc.). Idempotent — running
twice for the same org is a no-op.

Also seeds default account mappings so GL postings work out of the box.
"""
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from app.models.accounts import ChartOfAccounts, AccountMapping


# (code, name, type, group, is_group, parent_code) — flat list, parent_code resolves at insert time
DEFAULT_COA = [
    # ── 1xxx ASSETS ──────────────────────────────────────────────────
    ("1000", "Assets", "asset", "Assets", True, None),
    ("1100", "Current Assets", "asset", "Current Assets", True, "1000"),
    ("1110", "Cash in Hand", "asset", "Current Assets", False, "1100"),
    ("1120", "Bank Accounts", "asset", "Current Assets", False, "1100"),
    ("1130", "Accounts Receivable", "asset", "Receivables", False, "1100"),
    ("1140", "Advances to Vendors", "asset", "Current Assets", False, "1100"),
    ("1150", "GST Input Credit", "asset", "Tax", False, "1100"),
    ("1300", "Inventory", "asset", "Inventory", True, "1000"),
    ("1310", "Pharmacy Stock", "asset", "Inventory", False, "1300"),
    ("1320", "Medical Consumables", "asset", "Inventory", False, "1300"),
    ("1330", "Surgical Supplies", "asset", "Inventory", False, "1300"),
    ("1340", "General Stock", "asset", "Inventory", False, "1300"),
    ("1500", "Fixed Assets", "asset", "Fixed Assets", True, "1000"),
    ("1510", "Equipment", "asset", "Fixed Assets", False, "1500"),
    ("1520", "Furniture & Fixtures", "asset", "Fixed Assets", False, "1500"),
    # ── 2xxx LIABILITIES ────────────────────────────────────────────
    ("2000", "Liabilities", "liability", "Liabilities", True, None),
    ("2100", "Current Liabilities", "liability", "Current Liabilities", True, "2000"),
    ("2110", "Accounts Payable", "liability", "Payables", False, "2100"),
    ("2120", "GR-IR Clearing", "liability", "Clearing", False, "2100"),
    ("2130", "GST Output Liability", "liability", "Tax", False, "2100"),
    ("2140", "Salaries Payable", "liability", "Current Liabilities", False, "2100"),
    ("2150", "TDS Payable", "liability", "Tax", False, "2100"),
    # ── 3xxx EQUITY ─────────────────────────────────────────────────
    ("3000", "Equity", "equity", "Equity", True, None),
    ("3010", "Share Capital", "equity", "Equity", False, "3000"),
    ("3020", "Retained Earnings", "equity", "Equity", False, "3000"),
    # ── 4xxx INCOME ─────────────────────────────────────────────────
    ("4000", "Income", "income", "Income", True, None),
    ("4010", "Sales Revenue", "income", "Income", False, "4000"),
    ("4020", "Other Income", "income", "Income", False, "4000"),
    # ── 5xxx COGS / CONSUMPTION ─────────────────────────────────────
    ("5000", "Cost of Goods Sold", "expense", "COGS", True, None),
    ("5010", "Pharmacy Consumption", "expense", "COGS", False, "5000"),
    ("5020", "Consumables Consumption", "expense", "COGS", False, "5000"),
    ("5030", "Surgical Consumption", "expense", "COGS", False, "5000"),
    ("5040", "Stock Adjustment", "expense", "COGS", False, "5000"),
    ("5050", "Stock Write-off", "expense", "COGS", False, "5000"),
    # ── 6xxx OPERATING EXPENSES ─────────────────────────────────────
    ("6000", "Operating Expenses", "expense", "Operating Expenses", True, None),
    ("6010", "Salaries & Wages", "expense", "Operating Expenses", False, "6000"),
    ("6020", "Rent", "expense", "Operating Expenses", False, "6000"),
    ("6030", "Utilities", "expense", "Operating Expenses", False, "6000"),
    ("6040", "Freight & Transport", "expense", "Operating Expenses", False, "6000"),
    ("6050", "Office Supplies", "expense", "Operating Expenses", False, "6000"),
]


# Default account mappings (per event). Looked up by code, resolved to id at insert.
# format: (event, debit_code, credit_code)
DEFAULT_MAPPINGS = [
    # GRN: stock comes in, owe vendor (via GR-IR clearing until invoice booked)
    ("grn", "1340", "2120"),
    # Vendor invoice received: clear the GR-IR, recognize AP
    ("invoice", "2120", "2110"),
    # Payment to vendor: settle AP from bank
    ("payment", "2110", "1120"),
    # Material issue / consumption: stock leaves inventory, expensed
    ("issue", "5040", "1340"),
    ("consumption", "5010", "1340"),
    # Purchase return: reverse the GRN (stock out, GR-IR Dr)
    ("return", "2120", "1340"),
    # Opening stock: stock in, equity counter-balance
    ("opening_stock", "1340", "3020"),
]


async def seed_coa_for_org(db: AsyncSession, organization_id: int) -> dict:
    """Seed the standard chart of accounts and default mappings for one org.

    Idempotent: if any account or mapping already exists, that one is skipped
    (we never delete or mutate existing rows — Wave 6 does not own user-edited
    chart entries).
    """
    inserted_accounts = 0
    skipped_accounts = 0
    inserted_mappings = 0
    skipped_mappings = 0

    # 1. Build code → existing-row map for this org
    existing = await db.execute(
        select(ChartOfAccounts).where(ChartOfAccounts.organization_id == organization_id)
    )
    existing_by_code = {a.account_code: a for a in existing.scalars().all()}

    code_to_id: dict[str, int] = {c: a.id for c, a in existing_by_code.items()}

    # 2. Insert accounts in order (parents before children — list is already topologically sorted)
    for code, name, atype, group, is_group, parent_code in DEFAULT_COA:
        if code in existing_by_code:
            skipped_accounts += 1
            continue
        parent_id = code_to_id.get(parent_code) if parent_code else None
        level = 0
        if parent_code:
            parent = existing_by_code.get(parent_code)
            level = (parent.level if parent else 0) + 1
        acc = ChartOfAccounts(
            organization_id=organization_id,
            parent_id=parent_id,
            account_code=code,
            account_name=name,
            account_type=atype,
            account_group=group,
            is_group=is_group,
            level=level,
        )
        db.add(acc)
        await db.flush()
        code_to_id[code] = acc.id
        existing_by_code[code] = acc
        inserted_accounts += 1

    # 3. Insert default mappings
    existing_maps = await db.execute(
        select(AccountMapping).where(
            AccountMapping.organization_id == organization_id,
            AccountMapping.item_category_id.is_(None),
            AccountMapping.warehouse_id.is_(None),
        )
    )
    existing_events = {m.event for m in existing_maps.scalars().all()}

    for event, debit_code, credit_code in DEFAULT_MAPPINGS:
        if event in existing_events:
            skipped_mappings += 1
            continue
        debit_id = code_to_id.get(debit_code)
        credit_id = code_to_id.get(credit_code)
        if not debit_id or not credit_id:
            skipped_mappings += 1
            continue
        mapping = AccountMapping(
            organization_id=organization_id,
            event=event,
            item_category_id=None,
            warehouse_id=None,
            debit_account_id=debit_id,
            credit_account_id=credit_id,
            is_active=True,
        )
        db.add(mapping)
        inserted_mappings += 1

    await db.flush()

    return {
        "accounts_inserted": inserted_accounts,
        "accounts_skipped": skipped_accounts,
        "mappings_inserted": inserted_mappings,
        "mappings_skipped": skipped_mappings,
    }
