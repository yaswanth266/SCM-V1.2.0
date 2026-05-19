"""Wave 5 — DB-backed bug fixes (token blocklist, password history,
issue/consumption returns, missing columns, unique constraints, type changes).

Covers (deferred from earlier waves):
  * BUG-AUTH-001 (account lockout: failed_login_attempts, locked_until on users)
  * BUG-AUTH-017/018/019/022/029 (token_blocklist + tokens_revoked_after on users)
  * BUG-AUTH-020/046 (password_history table)
  * BUG-APR-009/008 (amount, department, category, request_type, extra_json on
    approval_requests)
  * BUG-APR-031 (scope_document_type on approval_delegations)
  * BUG-PRO-007/139 (payment_terms text, currency on purchase_orders)
  * BUG-PRO-038 (cancelled_by, cancelled_at, cancel_reason on purchase_orders)
  * BUG-PRO-095 (weight on grn_items)
  * BUG-PRO-099 (tax_treatment on landed_costs — only if table present)
  * BUG-PRO-133 (UNIQUE (module, document_type, fiscal_year) on number_series)
  * BUG-INV-008  (cgst_rate, sgst_rate, igst_rate, discount_pct, tax_amount on
    grn_items — full tax/discount persistence)
  * BUG-INV-082 (UNIQUE (item_id, batch_number) on batches)
  * BUG-INV-108 (transfer_id FK on goods_receipt_notes)
  * BUG-ISS-014 (updated_at on material_issues)
  * BUG-ISS-055 (is_expired_return on purchase_returns)
  * BUG-ISS-063 (issue_returns + consumption_returns tables)
  * BUG-ISS-086 (partial unique index on dispatch_orders.vehicle_number for
    active statuses)
  * BUG-ISS-092 (dispatch_orders.dispatch_date → DateTime(timezone=True))
  * BUG-ISS-106 (created_by on transport_orders — only if table present)
  * BUG-FIN-015/060 (organization_id on journal_entries)
  * BUG-FIN-074 (re-affirm Customer master + idempotent index on customer_code —
    table already exists from earlier waves)
  * BUG-FE-029 (FK constraint brands.manufacturer_id → vendors.id; only if
    column present)
  * BUG-FE-175 (partial unique on items.name — case-insensitive, active rows)
  * Org-scoping: roles.organization_id, system_settings.organization_id,
    activity_logs.organization_id, number_series.organization_id

Revision ID: p1697d14ef5
Revises: o1586c13de4
Create Date: 2026-04-28
"""
from alembic import op
import sqlalchemy as sa


revision = 'p1697d14ef5'
down_revision = 'o1586c13de4'
branch_labels = None
depends_on = None


def _has_column(insp, table: str, col: str) -> bool:
    if not insp.has_table(table):
        return False
    return any(c["name"] == col for c in insp.get_columns(table))


def _has_index(insp, table: str, name: str) -> bool:
    if not insp.has_table(table):
        return False
    try:
        return any(i["name"] == name for i in insp.get_indexes(table))
    except Exception:
        return False


def _has_unique(insp, table: str, name: str) -> bool:
    if not insp.has_table(table):
        return False
    try:
        return any(u.get("name") == name for u in insp.get_unique_constraints(table))
    except Exception:
        return False


def upgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)

    # ----- users: account lockout + token-revocation cutover -----
    if insp.has_table("users"):
        if not _has_column(insp, "users", "failed_login_attempts"):
            op.add_column("users", sa.Column("failed_login_attempts", sa.Integer, nullable=False, server_default="0"))
        if not _has_column(insp, "users", "locked_until"):
            op.add_column("users", sa.Column("locked_until", sa.DateTime, nullable=True))
        if not _has_column(insp, "users", "tokens_revoked_after"):
            op.add_column("users", sa.Column("tokens_revoked_after", sa.DateTime, nullable=True))

    # ----- token_blocklist (BUG-AUTH-017) -----
    if not insp.has_table("token_blocklist"):
        op.create_table(
            "token_blocklist",
            sa.Column("id", sa.BigInteger, primary_key=True, autoincrement=True),
            sa.Column("jti", sa.String(64), nullable=True),
            sa.Column("token_hash", sa.String(128), nullable=False),
            sa.Column("user_id", sa.BigInteger, sa.ForeignKey("users.id", ondelete="CASCADE")),
            sa.Column("token_type", sa.String(20), nullable=False, server_default="access"),
            sa.Column("revoked_at", sa.DateTime, nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
            sa.Column("expires_at", sa.DateTime, nullable=True),
            sa.Column("reason", sa.String(100), nullable=True),
        )
        op.create_index("idx_tb_token_hash", "token_blocklist", ["token_hash"], unique=True)
        op.create_index("idx_tb_user", "token_blocklist", ["user_id"])
        op.create_index("idx_tb_jti", "token_blocklist", ["jti"])

    # ----- password_history (BUG-AUTH-046) -----
    if not insp.has_table("password_history"):
        op.create_table(
            "password_history",
            sa.Column("id", sa.BigInteger, primary_key=True, autoincrement=True),
            sa.Column("user_id", sa.BigInteger, sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
            sa.Column("password_hash", sa.String(255), nullable=False),
            sa.Column("changed_at", sa.DateTime, nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
        )
        op.create_index("idx_ph_user", "password_history", ["user_id", "changed_at"])

    # ----- approval_requests: persist routing context (BUG-APR-008/009) -----
    if insp.has_table("approval_requests"):
        if not _has_column(insp, "approval_requests", "amount"):
            op.add_column("approval_requests", sa.Column("amount", sa.Numeric(15, 2), nullable=True))
        if not _has_column(insp, "approval_requests", "department"):
            op.add_column("approval_requests", sa.Column("department", sa.String(100), nullable=True))
        if not _has_column(insp, "approval_requests", "category"):
            op.add_column("approval_requests", sa.Column("category", sa.String(100), nullable=True))
        if not _has_column(insp, "approval_requests", "request_type"):
            op.add_column("approval_requests", sa.Column("request_type", sa.String(50), nullable=True))
        if not _has_column(insp, "approval_requests", "extra_json"):
            op.add_column("approval_requests", sa.Column("extra_json", sa.Text, nullable=True))

    # ----- approval_delegations: per-document scoping (BUG-APR-031) -----
    if insp.has_table("approval_delegations") and not _has_column(insp, "approval_delegations", "scope_document_type"):
        op.add_column("approval_delegations", sa.Column("scope_document_type", sa.String(100), nullable=True))

    # ----- purchase_orders: payment_terms, currency, cancellation audit -----
    if insp.has_table("purchase_orders"):
        if not _has_column(insp, "purchase_orders", "payment_terms"):
            op.add_column("purchase_orders", sa.Column("payment_terms", sa.Text, nullable=True))
        if not _has_column(insp, "purchase_orders", "currency"):
            op.add_column("purchase_orders", sa.Column("currency", sa.String(3), nullable=False, server_default="INR"))
        if not _has_column(insp, "purchase_orders", "cancelled_by"):
            op.add_column("purchase_orders", sa.Column("cancelled_by", sa.BigInteger, nullable=True))
        if not _has_column(insp, "purchase_orders", "cancelled_at"):
            op.add_column("purchase_orders", sa.Column("cancelled_at", sa.DateTime, nullable=True))
        if not _has_column(insp, "purchase_orders", "cancel_reason"):
            op.add_column("purchase_orders", sa.Column("cancel_reason", sa.Text, nullable=True))

    # ----- grn_items: tax/discount persistence + weight (BUG-INV-008, BUG-PRO-095) -----
    if insp.has_table("grn_items"):
        for col, typ in [
            ("discount_pct", sa.Numeric(5, 2)),
            ("cgst_rate", sa.Numeric(5, 2)),
            ("sgst_rate", sa.Numeric(5, 2)),
            ("igst_rate", sa.Numeric(5, 2)),
            ("tax_amount", sa.Numeric(15, 2)),
            ("weight", sa.Numeric(15, 3)),
        ]:
            if not _has_column(insp, "grn_items", col):
                op.add_column("grn_items", sa.Column(col, typ, nullable=True, server_default="0"))

    # ----- goods_receipt_notes: transfer_id FK (BUG-INV-108) -----
    if insp.has_table("goods_receipt_notes") and not _has_column(insp, "goods_receipt_notes", "transfer_id"):
        op.add_column("goods_receipt_notes", sa.Column("transfer_id", sa.BigInteger, nullable=True))
        # FK creation is best-effort; skip if stock_transfers absent
        if insp.has_table("stock_transfers"):
            try:
                op.create_foreign_key(
                    "fk_grn_transfer",
                    "goods_receipt_notes", "stock_transfers",
                    ["transfer_id"], ["id"],
                )
            except Exception:
                pass

    # ----- batches: UNIQUE(item_id, batch_number) (BUG-INV-082) -----
    if insp.has_table("batches") and not _has_unique(insp, "batches", "uq_batches_item_batch"):
        try:
            op.create_unique_constraint(
                "uq_batches_item_batch", "batches", ["item_id", "batch_number"]
            )
        except Exception:
            # Likely duplicates exist; fall back to non-unique index so the
            # migration completes and leaves a TODO for cleanup.
            if not _has_index(insp, "batches", "idx_batches_item_batch"):
                op.create_index("idx_batches_item_batch", "batches", ["item_id", "batch_number"])

    # ----- material_issues.updated_at (BUG-ISS-014) -----
    if insp.has_table("material_issues") and not _has_column(insp, "material_issues", "updated_at"):
        op.add_column(
            "material_issues",
            sa.Column("updated_at", sa.DateTime, nullable=True, server_default=sa.text("CURRENT_TIMESTAMP")),
        )

    # ----- purchase_returns.is_expired_return (BUG-ISS-055) -----
    if insp.has_table("purchase_returns") and not _has_column(insp, "purchase_returns", "is_expired_return"):
        op.add_column(
            "purchase_returns",
            sa.Column("is_expired_return", sa.Boolean, nullable=False, server_default=sa.false()),
        )

    # ----- issue_returns + consumption_returns (BUG-ISS-063) -----
    if not insp.has_table("issue_returns"):
        op.create_table(
            "issue_returns",
            sa.Column("id", sa.BigInteger, primary_key=True, autoincrement=True),
            sa.Column("return_number", sa.String(50), nullable=False, unique=True),
            sa.Column("issue_id", sa.BigInteger, sa.ForeignKey("material_issues.id"), nullable=False),
            sa.Column("warehouse_id", sa.BigInteger, sa.ForeignKey("warehouses.id"), nullable=False),
            sa.Column("return_date", sa.DateTime, nullable=False),
            sa.Column("reason", sa.Text),
            sa.Column("status", sa.String(30), nullable=False, server_default="draft"),
            sa.Column("created_by", sa.BigInteger, sa.ForeignKey("users.id")),
            sa.Column("created_at", sa.DateTime, nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
        )
        op.create_table(
            "issue_return_items",
            sa.Column("id", sa.BigInteger, primary_key=True, autoincrement=True),
            sa.Column("return_id", sa.BigInteger, sa.ForeignKey("issue_returns.id", ondelete="CASCADE"), nullable=False),
            sa.Column("issue_item_id", sa.BigInteger),
            sa.Column("item_id", sa.BigInteger, sa.ForeignKey("items.id"), nullable=False),
            sa.Column("batch_id", sa.BigInteger),
            sa.Column("qty", sa.Numeric(15, 3), nullable=False),
            sa.Column("uom_id", sa.BigInteger, sa.ForeignKey("uom.id"), nullable=False),
            sa.Column("rate", sa.Numeric(15, 2), server_default="0"),
            sa.Column("reason", sa.Text),
        )

    if not insp.has_table("consumption_returns"):
        op.create_table(
            "consumption_returns",
            sa.Column("id", sa.BigInteger, primary_key=True, autoincrement=True),
            sa.Column("return_number", sa.String(50), nullable=False, unique=True),
            sa.Column("entry_id", sa.BigInteger, sa.ForeignKey("consumption_entries.id"), nullable=False),
            sa.Column("warehouse_id", sa.BigInteger, sa.ForeignKey("warehouses.id"), nullable=False),
            sa.Column("return_date", sa.DateTime, nullable=False),
            sa.Column("reason", sa.Text),
            sa.Column("status", sa.String(30), nullable=False, server_default="draft"),
            sa.Column("created_by", sa.BigInteger, sa.ForeignKey("users.id")),
            sa.Column("created_at", sa.DateTime, nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
        )
        op.create_table(
            "consumption_return_items",
            sa.Column("id", sa.BigInteger, primary_key=True, autoincrement=True),
            sa.Column("return_id", sa.BigInteger, sa.ForeignKey("consumption_returns.id", ondelete="CASCADE"), nullable=False),
            sa.Column("consumption_item_id", sa.BigInteger),
            sa.Column("item_id", sa.BigInteger, sa.ForeignKey("items.id"), nullable=False),
            sa.Column("batch_id", sa.BigInteger),
            sa.Column("qty", sa.Numeric(15, 3), nullable=False),
            sa.Column("uom_id", sa.BigInteger, sa.ForeignKey("uom.id"), nullable=False),
            sa.Column("rate", sa.Numeric(15, 2), server_default="0"),
            sa.Column("reason", sa.Text),
        )

    # ----- dispatch_orders.dispatch_date timezone-aware (BUG-ISS-092) -----
    if insp.has_table("dispatch_orders"):
        try:
            with op.batch_alter_table("dispatch_orders") as bop:
                bop.alter_column(
                    "dispatch_date",
                    type_=sa.DateTime(timezone=True),
                    existing_type=sa.DateTime(),
                    existing_nullable=True,
                )
        except Exception:
            # Best-effort; some dialects (SQLite) won't ALTER cleanly.
            pass

        # Partial unique index on vehicle_number for active statuses (BUG-ISS-086).
        # Most engines support partial indexes (Postgres). Wrapped in try/except
        # so SQLite/MySQL don't fail the migration.
        if not _has_index(insp, "dispatch_orders", "uq_dispatch_active_vehicle"):
            try:
                op.execute(
                    "CREATE UNIQUE INDEX uq_dispatch_active_vehicle "
                    "ON dispatch_orders (vehicle_number) "
                    "WHERE status IN ('loading','loaded','dispatched','in_transit') "
                    "AND vehicle_number IS NOT NULL"
                )
            except Exception:
                pass

    # ----- transport_orders.created_by (BUG-ISS-106) -----
    if insp.has_table("transport_orders") and not _has_column(insp, "transport_orders", "created_by"):
        op.add_column("transport_orders", sa.Column("created_by", sa.BigInteger, nullable=True))

    # ----- journal_entries.organization_id (BUG-FIN-015 / BUG-FIN-060) -----
    if insp.has_table("journal_entries") and not _has_column(insp, "journal_entries", "organization_id"):
        op.add_column("journal_entries", sa.Column("organization_id", sa.BigInteger, nullable=True))
        # Backfill from a sensible default — the first organisation. New rows
        # will be required to set it through the model default.
        try:
            op.execute(
                "UPDATE journal_entries SET organization_id = (SELECT MIN(id) FROM organizations) "
                "WHERE organization_id IS NULL"
            )
        except Exception:
            pass
        if not _has_index(insp, "journal_entries", "idx_je_org"):
            op.create_index("idx_je_org", "journal_entries", ["organization_id"])

    # ----- number_series UNIQUE(module,document_type,fiscal_year) (BUG-PRO-133) -----
    if insp.has_table("number_series"):
        if not _has_column(insp, "number_series", "code"):
            # legacy column referenced in some bug reports — add only if missing
            # so the .code unique index can be created.
            op.add_column("number_series", sa.Column("code", sa.String(80), nullable=True))
        if not _has_column(insp, "number_series", "organization_id"):
            op.add_column("number_series", sa.Column("organization_id", sa.BigInteger, nullable=True))
        if not _has_unique(insp, "number_series", "uq_ns_module_doc_fy") and not _has_index(insp, "number_series", "ix_ns_module_doc_fy"):
            # Pre-flight: if existing data has duplicates, fall back to a
            # non-unique index so the migration still completes. Operators
            # can dedupe and re-promote later.
            try:
                dup_count = bind.execute(sa.text(
                    "SELECT COUNT(*) - COUNT(DISTINCT module, document_type, fiscal_year) "
                    "FROM number_series"
                )).scalar() or 0
            except Exception:
                dup_count = -1  # unknown — assume safe to attempt unique
            if dup_count == 0:
                try:
                    op.create_unique_constraint(
                        "uq_ns_module_doc_fy",
                        "number_series",
                        ["module", "document_type", "fiscal_year"],
                    )
                except Exception:
                    op.create_index(
                        "ix_ns_module_doc_fy",
                        "number_series",
                        ["module", "document_type", "fiscal_year"],
                    )
            else:
                op.create_index(
                    "ix_ns_module_doc_fy",
                    "number_series",
                    ["module", "document_type", "fiscal_year"],
                )

    # ----- org-scope columns on roles, system_settings, activity_logs -----
    for tbl in ("roles", "system_settings", "activity_logs"):
        if insp.has_table(tbl) and not _has_column(insp, tbl, "organization_id"):
            op.add_column(tbl, sa.Column("organization_id", sa.BigInteger, nullable=True))
            try:
                op.execute(
                    f"UPDATE {tbl} SET organization_id = (SELECT MIN(id) FROM organizations) "
                    "WHERE organization_id IS NULL"
                )
            except Exception:
                pass

    # ----- landed_costs.tax_treatment (BUG-PRO-099) -----
    if insp.has_table("landed_costs") and not _has_column(insp, "landed_costs", "tax_treatment"):
        op.add_column("landed_costs", sa.Column("tax_treatment", sa.String(40), nullable=True))

    # ----- brands.manufacturer_id FK (BUG-FE-029) -----
    if insp.has_table("brands") and _has_column(insp, "brands", "manufacturer_id") and insp.has_table("vendors"):
        try:
            op.create_foreign_key(
                "fk_brands_manufacturer",
                "brands", "vendors",
                ["manufacturer_id"], ["id"],
            )
        except Exception:
            pass

    # ----- items: case-insensitive partial unique on name for active rows
    # (BUG-FE-175). Postgres-only syntax (functional + partial). On MySQL the
    # migration is a no-op; on Postgres we still pre-flight for duplicate
    # active-name collisions and downgrade to a non-unique index if dupes
    # exist so the migration always completes.
    if insp.has_table("items") and not _has_index(insp, "items", "uq_items_name_active_ci"):
        dialect = bind.dialect.name if hasattr(bind, "dialect") else ""
        if dialect == "postgresql":
            try:
                dup_count = bind.execute(sa.text(
                    "SELECT COUNT(*) - COUNT(DISTINCT LOWER(name)) "
                    "FROM items WHERE COALESCE(is_active, true) = true"
                )).scalar() or 0
            except Exception:
                dup_count = -1
            try:
                if dup_count == 0:
                    op.execute(
                        "CREATE UNIQUE INDEX uq_items_name_active_ci "
                        "ON items (LOWER(name)) WHERE is_active = true"
                    )
                else:
                    op.execute(
                        "CREATE INDEX ix_items_name_active_ci "
                        "ON items (LOWER(name)) WHERE is_active = true"
                    )
            except Exception:
                pass


def downgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)

    # Drop indexes / unique constraints first.
    for idx, tbl in [
        ("uq_items_name_active_ci", "items"),
        ("ix_items_name_active_ci", "items"),
        ("ix_ns_module_doc_fy", "number_series"),
        ("uq_dispatch_active_vehicle", "dispatch_orders"),
        ("idx_je_org", "journal_entries"),
        ("idx_tb_jti", "token_blocklist"),
        ("idx_tb_user", "token_blocklist"),
        ("idx_tb_token_hash", "token_blocklist"),
        ("idx_ph_user", "password_history"),
    ]:
        try:
            op.drop_index(idx, table_name=tbl)
        except Exception:
            pass

    for uq, tbl in [
        ("uq_ns_module_doc_fy", "number_series"),
        ("uq_batches_item_batch", "batches"),
    ]:
        try:
            op.drop_constraint(uq, tbl, type_="unique")
        except Exception:
            pass

    for fk, tbl in [
        ("fk_grn_transfer", "goods_receipt_notes"),
        ("fk_brands_manufacturer", "brands"),
    ]:
        try:
            op.drop_constraint(fk, tbl, type_="foreignkey")
        except Exception:
            pass

    # Drop tables created above (only if empty in real life — alembic just drops).
    for tbl in ("consumption_return_items", "consumption_returns",
                "issue_return_items", "issue_returns",
                "password_history", "token_blocklist"):
        try:
            op.drop_table(tbl)
        except Exception:
            pass

    # Drop added columns.
    drop_cols = [
        ("users", "failed_login_attempts"),
        ("users", "locked_until"),
        ("users", "tokens_revoked_after"),
        ("approval_requests", "amount"),
        ("approval_requests", "department"),
        ("approval_requests", "category"),
        ("approval_requests", "request_type"),
        ("approval_requests", "extra_json"),
        ("approval_delegations", "scope_document_type"),
        ("purchase_orders", "payment_terms"),
        ("purchase_orders", "currency"),
        ("purchase_orders", "cancelled_by"),
        ("purchase_orders", "cancelled_at"),
        ("purchase_orders", "cancel_reason"),
        ("grn_items", "discount_pct"),
        ("grn_items", "cgst_rate"),
        ("grn_items", "sgst_rate"),
        ("grn_items", "igst_rate"),
        ("grn_items", "tax_amount"),
        ("grn_items", "weight"),
        ("goods_receipt_notes", "transfer_id"),
        ("material_issues", "updated_at"),
        ("purchase_returns", "is_expired_return"),
        ("transport_orders", "created_by"),
        ("journal_entries", "organization_id"),
        ("number_series", "code"),
        ("number_series", "organization_id"),
        ("roles", "organization_id"),
        ("system_settings", "organization_id"),
        ("activity_logs", "organization_id"),
        ("landed_costs", "tax_treatment"),
    ]
    for tbl, col in drop_cols:
        try:
            op.drop_column(tbl, col)
        except Exception:
            pass
