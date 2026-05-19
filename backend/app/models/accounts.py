from sqlalchemy import Column, BigInteger, String, Text, Boolean, DateTime, Enum, ForeignKey, Numeric, Integer, Index
from sqlalchemy.orm import relationship
from datetime import datetime, timezone
from app.database import Base


class ChartOfAccounts(Base):
    __tablename__ = "chart_of_accounts"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    parent_id = Column(BigInteger, ForeignKey("chart_of_accounts.id"))
    project_id = Column(BigInteger, ForeignKey("projects.id"))
    organization_id = Column(BigInteger, ForeignKey("organizations.id"))
    account_code = Column(String(50), nullable=False)
    account_name = Column(String(255), nullable=False)
    account_type = Column(Enum("asset", "liability", "equity", "income", "expense", name="account_type_enum"), nullable=False)
    account_group = Column(String(100))
    is_group = Column(Boolean, default=False)
    level = Column(Integer, default=0)
    currency = Column(String(3), default="INR")
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))

    parent = relationship("ChartOfAccounts", remote_side=[id])
    project = relationship("Project")


class Invoice(Base):
    __tablename__ = "invoices"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    invoice_number = Column(String(50), unique=True, nullable=False)
    invoice_type = Column(Enum("purchase", "sales", name="invoice_type_enum"), nullable=False)
    party_type = Column(Enum("vendor", "customer", name="invoice_party_type_enum"), nullable=False)
    party_id = Column(BigInteger, nullable=False)
    po_id = Column(BigInteger)
    so_id = Column(BigInteger)
    project_id = Column(BigInteger, ForeignKey("projects.id"))
    invoice_date = Column(DateTime, nullable=False)
    due_date = Column(DateTime)
    subtotal = Column(Numeric(15, 2), default=0)
    cgst_amount = Column(Numeric(15, 2), default=0)
    sgst_amount = Column(Numeric(15, 2), default=0)
    igst_amount = Column(Numeric(15, 2), default=0)
    tax_amount = Column(Numeric(15, 2), default=0)
    discount_amount = Column(Numeric(15, 2), default=0)
    grand_total = Column(Numeric(15, 2), default=0)
    paid_amount = Column(Numeric(15, 2), default=0)
    balance_amount = Column(Numeric(15, 2), default=0)
    status = Column(Enum("draft", "submitted", "partially_paid", "paid", "overdue", "cancelled", name="invoice_status_enum"), default="draft")
    remarks = Column(Text)
    attachment_url = Column(String(500))
    created_by = Column(BigInteger)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    updated_at = Column(DateTime, default=lambda: datetime.now(timezone.utc), onupdate=lambda: datetime.now(timezone.utc))

    project = relationship("Project")
    items = relationship("InvoiceItem", back_populates="invoice", cascade="all, delete-orphan")


class InvoiceItem(Base):
    __tablename__ = "invoice_items"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    invoice_id = Column(BigInteger, ForeignKey("invoices.id", ondelete="CASCADE"), nullable=False)
    item_id = Column(BigInteger, ForeignKey("items.id"), nullable=False)
    qty = Column(Numeric(15, 3), nullable=False)
    uom_id = Column(BigInteger, ForeignKey("uom.id"), nullable=False)
    rate = Column(Numeric(15, 2), nullable=False)
    discount_pct = Column(Numeric(5, 2), default=0)
    cgst_rate = Column(Numeric(5, 2), default=0)
    sgst_rate = Column(Numeric(5, 2), default=0)
    igst_rate = Column(Numeric(5, 2), default=0)
    tax_amount = Column(Numeric(15, 2), default=0)
    amount = Column(Numeric(15, 2), default=0)

    invoice = relationship("Invoice", back_populates="items")
    item = relationship("Item")
    uom = relationship("UOM")


class Payment(Base):
    __tablename__ = "payments"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    payment_number = Column(String(50), unique=True, nullable=False)
    payment_type = Column(Enum("receive", "pay", name="payment_type_enum"), nullable=False)
    party_type = Column(Enum("vendor", "customer", name="payment_party_type_enum"), nullable=False)
    party_id = Column(BigInteger, nullable=False)
    invoice_id = Column(BigInteger, ForeignKey("invoices.id"))
    po_id = Column(BigInteger)
    project_id = Column(BigInteger, ForeignKey("projects.id"))
    payment_date = Column(DateTime, nullable=False)
    amount = Column(Numeric(15, 2), nullable=False)
    payment_mode = Column(Enum("cash", "bank_transfer", "cheque", "upi", "dd", "advance", name="payment_mode_enum"), default="bank_transfer")
    reference_number = Column(String(100))
    bank_account = Column(String(100))
    is_advance = Column(Boolean, default=False)
    status = Column(Enum("draft", "submitted", "reconciled", "cancelled", name="payment_status_enum"), default="draft")
    remarks = Column(Text)
    created_by = Column(BigInteger)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))

    invoice = relationship("Invoice")
    project = relationship("Project")


class CreditNote(Base):
    __tablename__ = "credit_notes"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    cn_number = Column(String(50), unique=True, nullable=False)
    invoice_id = Column(BigInteger, ForeignKey("invoices.id"), nullable=False)
    party_type = Column(Enum("vendor", "customer", name="cn_party_type_enum"), nullable=False)
    party_id = Column(BigInteger, nullable=False)
    cn_date = Column(DateTime, nullable=False)
    amount = Column(Numeric(15, 2), nullable=False)
    reason = Column(Text)
    status = Column(Enum("draft", "issued", "adjusted", "cancelled", name="cn_status_enum"), default="draft")
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))

    invoice = relationship("Invoice")


class JournalEntry(Base):
    __tablename__ = "journal_entries"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    entry_number = Column(String(50), unique=True, nullable=False)
    entry_date = Column(DateTime, nullable=False)
    entry_type = Column(Enum("journal", "opening", "closing", "adjustment", name="je_type_enum"), default="journal")
    # Wave 5 — org scope so list_journal_entries can enforce tenant isolation
    # (BUG-FIN-015 / BUG-FIN-060). Backfilled to org 1 by the migration.
    organization_id = Column(BigInteger, ForeignKey("organizations.id"))
    project_id = Column(BigInteger, ForeignKey("projects.id"))
    reference_type = Column(String(50))
    reference_id = Column(BigInteger)
    total_debit = Column(Numeric(15, 2), default=0)
    total_credit = Column(Numeric(15, 2), default=0)
    narration = Column(Text)
    status = Column(Enum("draft", "posted", "cancelled", name="je_status_enum"), default="draft")
    created_by = Column(BigInteger)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))

    project = relationship("Project")
    lines = relationship("JournalEntryLine", back_populates="journal_entry", cascade="all, delete-orphan")


class JournalEntryLine(Base):
    __tablename__ = "journal_entry_lines"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    je_id = Column(BigInteger, ForeignKey("journal_entries.id", ondelete="CASCADE"), nullable=False)
    account_id = Column(BigInteger, ForeignKey("chart_of_accounts.id"), nullable=False)
    debit = Column(Numeric(15, 2), default=0)
    credit = Column(Numeric(15, 2), default=0)
    party_type = Column(Enum("vendor", "customer", name="jel_party_type_enum"))
    party_id = Column(BigInteger)
    narration = Column(Text)

    journal_entry = relationship("JournalEntry", back_populates="lines")
    account = relationship("ChartOfAccounts")


class AccountLedger(Base):
    __tablename__ = "account_ledger"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    account_id = Column(BigInteger, ForeignKey("chart_of_accounts.id"), nullable=False)
    posting_date = Column(DateTime, nullable=False)
    party_type = Column(Enum("vendor", "customer", name="al_party_type_enum"))
    party_id = Column(BigInteger)
    project_id = Column(BigInteger)
    po_id = Column(BigInteger)
    reference_type = Column(String(50))
    reference_id = Column(BigInteger)
    debit = Column(Numeric(15, 2), default=0)
    credit = Column(Numeric(15, 2), default=0)
    balance = Column(Numeric(15, 2), default=0)
    narration = Column(Text)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))

    account = relationship("ChartOfAccounts")

    __table_args__ = (
        Index("idx_al_account", "account_id"),
        Index("idx_al_party", "party_type", "party_id"),
        Index("idx_al_project", "project_id"),
    )


class AccountMapping(Base):
    """Resolves which GL account to debit/credit for a given event.

    Lookup precedence (most specific first):
      1. (event, item_category_id, warehouse_id)
      2. (event, item_category_id, NULL)
      3. (event, NULL, warehouse_id)
      4. (event, NULL, NULL)  ← org-wide default
    """
    __tablename__ = "account_mappings"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    organization_id = Column(BigInteger, ForeignKey("organizations.id"), nullable=False)
    event = Column(
        Enum("grn", "invoice", "payment", "issue", "return", "consumption", "opening_stock",
             name="gl_event_enum"),
        nullable=False,
    )
    item_category_id = Column(BigInteger, ForeignKey("item_categories.id"))
    warehouse_id = Column(BigInteger, ForeignKey("warehouses.id"))
    debit_account_id = Column(BigInteger, ForeignKey("chart_of_accounts.id"))
    credit_account_id = Column(BigInteger, ForeignKey("chart_of_accounts.id"))
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))

    debit_account = relationship("ChartOfAccounts", foreign_keys=[debit_account_id])
    credit_account = relationship("ChartOfAccounts", foreign_keys=[credit_account_id])

    __table_args__ = (
        Index("idx_am_org_event", "organization_id", "event", "is_active"),
        Index("idx_am_lookup", "event", "item_category_id", "warehouse_id"),
    )


class FiscalYear(Base):
    __tablename__ = "fiscal_years"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    organization_id = Column(BigInteger, ForeignKey("organizations.id"), nullable=False)
    year_label = Column(String(20), nullable=False)
    start_date = Column(DateTime, nullable=False)
    end_date = Column(DateTime, nullable=False)
    is_closed = Column(Boolean, default=False)
    closed_at = Column(DateTime)
    closed_by = Column(BigInteger, ForeignKey("users.id"))
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))

    __table_args__ = (
        Index("idx_fy_org", "organization_id"),
    )
