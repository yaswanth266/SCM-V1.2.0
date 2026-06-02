import re

from sqlalchemy import text
from sqlalchemy.exc import OperationalError
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncSession

from app.models.master import Feature, ItemFeature, UOMCategory, UOMConversion, ItemUOMConversion, VendorType, VendorCategory, VendorVendorType, VendorItemHistory, SpecCategory, Spec, ItemSpec, ItemSpecValue, Office, Position, Employee, UserItemPermission, RoleItemPermission, PackagingLevel, ItemPackaging
from app.models.vendor_portal import VendorUser


async def ensure_user_item_permission_schema(session: AsyncSession) -> None:
    conn = await session.connection()
    await conn.run_sync(UserItemPermission.__table__.create, checkfirst=True)
    await conn.run_sync(RoleItemPermission.__table__.create, checkfirst=True)
    idx_exists = (await conn.execute(text("""
        SELECT 1
        FROM information_schema.statistics
        WHERE table_schema = DATABASE()
          AND table_name = 'user_item_permissions'
          AND index_name = 'uq_user_item_permissions_scope'
        UNION
        SELECT 1
        FROM information_schema.table_constraints
        WHERE table_schema = DATABASE()
          AND table_name = 'user_item_permissions'
          AND constraint_name = 'uq_user_item_permissions_scope'
        LIMIT 1
    """))).scalar_one_or_none()
    if idx_exists is None:
        try:
            await conn.execute(text("""
                ALTER TABLE user_item_permissions
                ADD CONSTRAINT uq_user_item_permissions_scope
                UNIQUE (user_id, entity_type, entity_id, action)
            """))
        except OperationalError as exc:
            if "Duplicate key name" not in str(exc):
                raise


async def ensure_supplier_portal_schema(session: AsyncSession) -> None:
    conn = await session.connection()
    await conn.run_sync(VendorUser.__table__.create, checkfirst=True)

    columns = {
        row[0]
        for row in (await conn.execute(text("""
            SELECT column_name
            FROM information_schema.columns
            WHERE table_schema = DATABASE()
              AND table_name = 'vendor_users'
        """))).all()
    }

    missing_columns = {
        "full_name": "ALTER TABLE vendor_users ADD COLUMN full_name VARCHAR(200) NULL",
        "phone": "ALTER TABLE vendor_users ADD COLUMN phone VARCHAR(20) NULL",
        "is_active": "ALTER TABLE vendor_users ADD COLUMN is_active TINYINT(1) NOT NULL DEFAULT 1",
        "must_change_password": "ALTER TABLE vendor_users ADD COLUMN must_change_password TINYINT(1) NOT NULL DEFAULT 1",
        "failed_login_attempts": "ALTER TABLE vendor_users ADD COLUMN failed_login_attempts INT NOT NULL DEFAULT 0",
        "locked_until": "ALTER TABLE vendor_users ADD COLUMN locked_until DATETIME NULL",
        "last_login": "ALTER TABLE vendor_users ADD COLUMN last_login DATETIME NULL",
        "password_changed_at": "ALTER TABLE vendor_users ADD COLUMN password_changed_at DATETIME NULL",
        "created_at": "ALTER TABLE vendor_users ADD COLUMN created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP",
        "updated_at": "ALTER TABLE vendor_users ADD COLUMN updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP",
        "created_by": "ALTER TABLE vendor_users ADD COLUMN created_by BIGINT NULL",
    }
    for column_name, ddl in missing_columns.items():
        if column_name not in columns:
            await conn.execute(text(ddl))

    indexes = {
        row[0]
        for row in (await conn.execute(text("""
            SELECT index_name
            FROM information_schema.statistics
            WHERE table_schema = DATABASE()
              AND table_name = 'vendor_users'
        """))).all()
    }

    if "idx_vendor_users_vendor" not in indexes:
        try:
            await conn.execute(text("CREATE INDEX idx_vendor_users_vendor ON vendor_users (vendor_id)"))
        except OperationalError as exc:
            if "Duplicate key name" not in str(exc):
                raise
    if "idx_vendor_users_username" not in indexes:
        try:
            await conn.execute(text("CREATE UNIQUE INDEX idx_vendor_users_username ON vendor_users (username)"))
        except OperationalError as exc:
            if "Duplicate key name" not in str(exc):
                raise


async def ensure_rfq_schema(session: AsyncSession) -> None:
    conn = await session.connection()

    from app.models.procurement import RFQ, RFQItem, RFQVendor
    await conn.run_sync(RFQ.__table__.create, checkfirst=True)
    await conn.run_sync(RFQItem.__table__.create, checkfirst=True)
    await conn.run_sync(RFQVendor.__table__.create, checkfirst=True)

    quotation_columns = {
        row[0]
        for row in (await conn.execute(text("""
            SELECT column_name
            FROM information_schema.columns
            WHERE table_schema = DATABASE()
              AND table_name = 'quotations'
        """))).all()
    }
    if "rfq_number" not in quotation_columns:
        await conn.execute(text("ALTER TABLE quotations ADD COLUMN rfq_number VARCHAR(50) NULL"))
    if "with_vehicle" not in quotation_columns:
        await conn.execute(text("ALTER TABLE quotations ADD COLUMN with_vehicle TINYINT(1) NOT NULL DEFAULT 0"))
    if "rfq_id" not in quotation_columns:
        await conn.execute(text("ALTER TABLE quotations ADD COLUMN rfq_id BIGINT NULL"))
        try:
            await conn.execute(text("ALTER TABLE quotations ADD CONSTRAINT fk_quotations_rfq_id FOREIGN KEY (rfq_id) REFERENCES rfqs (id) ON DELETE CASCADE"))
        except Exception:
            pass
    if "subtotal" not in quotation_columns:
        await conn.execute(text("ALTER TABLE quotations ADD COLUMN subtotal DECIMAL(15, 2) NOT NULL DEFAULT 0"))
    if "vehicle_cost" not in quotation_columns:
        await conn.execute(text("ALTER TABLE quotations ADD COLUMN vehicle_cost DECIMAL(15, 2) NOT NULL DEFAULT 0"))

    quotation_indexes = {
        row[0]
        for row in (await conn.execute(text("""
            SELECT index_name
            FROM information_schema.statistics
            WHERE table_schema = DATABASE()
              AND table_name = 'quotations'
        """))).all()
    }
    if "idx_quotations_rfq_number" not in quotation_indexes:
        try:
            await conn.execute(text("CREATE INDEX idx_quotations_rfq_number ON quotations (rfq_number)"))
        except OperationalError as exc:
            if "Duplicate key name" not in str(exc):
                raise

    item_columns = {
        row[0]
        for row in (await conn.execute(text("""
            SELECT column_name
            FROM information_schema.columns
            WHERE table_schema = DATABASE()
              AND table_name = 'quotation_items'
        """))).all()
    }
    if "expected_delivery" not in item_columns:
        await conn.execute(text("ALTER TABLE quotation_items ADD COLUMN expected_delivery DATETIME NULL"))
    if "remarks" not in item_columns:
        await conn.execute(text("ALTER TABLE quotation_items ADD COLUMN remarks TEXT NULL"))

    employee_idx_exists = (await conn.execute(text("""
        SELECT 1
        FROM information_schema.statistics
        WHERE table_schema = DATABASE()
          AND table_name = 'role_item_permissions'
          AND index_name = 'uq_role_item_permissions_scope'
        UNION
        SELECT 1
        FROM information_schema.table_constraints
        WHERE table_schema = DATABASE()
          AND table_name = 'role_item_permissions'
          AND constraint_name = 'uq_role_item_permissions_scope'
        LIMIT 1
    """))).scalar_one_or_none()
    if employee_idx_exists is None:
        try:
            await conn.execute(text("""
                ALTER TABLE role_item_permissions
                ADD CONSTRAINT uq_role_item_permissions_scope
                UNIQUE (role_id, entity_type, entity_id, action)
            """))
        except OperationalError as exc:
            if "Duplicate key name" not in str(exc):
                raise

    po_columns = {
        row[0]
        for row in (await conn.execute(text("""
            SELECT column_name
            FROM information_schema.columns
            WHERE table_schema = DATABASE()
              AND table_name = 'purchase_orders'
        """))).all()
    }
    if "supplier_acknowledgement" not in po_columns:
        await conn.execute(text("ALTER TABLE purchase_orders ADD COLUMN supplier_acknowledgement VARCHAR(50) NOT NULL DEFAULT 'pending'"))


async def ensure_organization_structure_schema(session: AsyncSession) -> None:
    conn = await session.connection()
    await conn.run_sync(Office.__table__.create, checkfirst=True)
    await conn.run_sync(Position.__table__.create, checkfirst=True)
    await conn.run_sync(Employee.__table__.create, checkfirst=True)

    position_role_exists = (await conn.execute(text("""
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = DATABASE()
          AND table_name = 'positions'
          AND column_name = 'role_id'
        LIMIT 1
    """))).scalar_one_or_none()
    if position_role_exists is None:
        await conn.execute(text("ALTER TABLE positions ADD COLUMN role_id BIGINT NULL"))

    position_role_fk_exists = (await conn.execute(text("""
        SELECT 1
        FROM information_schema.key_column_usage
        WHERE table_schema = DATABASE()
          AND table_name = 'positions'
          AND column_name = 'role_id'
          AND referenced_table_name = 'roles'
        LIMIT 1
    """))).scalar_one_or_none()
    if position_role_fk_exists is None:
        await conn.execute(text("""
            ALTER TABLE positions
            ADD CONSTRAINT fk_positions_role_id
            FOREIGN KEY (role_id) REFERENCES roles (id)
            ON DELETE SET NULL
        """))

    employee_link_exists = (await conn.execute(text("""
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = DATABASE()
          AND table_name = 'users'
          AND column_name = 'employee_id'
        LIMIT 1
    """))).scalar_one_or_none()
    if employee_link_exists is None:
        await conn.execute(text("ALTER TABLE users ADD COLUMN employee_id BIGINT NULL"))

    employee_fk_exists = (await conn.execute(text("""
        SELECT 1
        FROM information_schema.key_column_usage
        WHERE table_schema = DATABASE()
          AND table_name = 'users'
          AND column_name = 'employee_id'
          AND referenced_table_name = 'employees'
        LIMIT 1
    """))).scalar_one_or_none()
    if employee_fk_exists is None:
        await conn.execute(text("""
            ALTER TABLE users
            ADD CONSTRAINT fk_users_employee_id
            FOREIGN KEY (employee_id) REFERENCES employees (id)
            ON DELETE SET NULL
        """))

    await conn.execute(text("""
        INSERT INTO employees (employee_code, name, status, email, phone)
        SELECT
            u.employee_code,
            TRIM(CONCAT(COALESCE(u.first_name, ''), ' ', COALESCE(u.last_name, ''))),
            CASE WHEN COALESCE(u.is_active, 1) = 1 THEN 'Active' ELSE 'Inactive' END,
            CASE
                WHEN u.email IS NOT NULL
                 AND NOT EXISTS (
                     SELECT 1 FROM employees e2
                     WHERE e2.email COLLATE utf8mb4_unicode_ci = u.email COLLATE utf8mb4_unicode_ci
                 )
                THEN u.email
                ELSE NULL
            END,
            LEFT(u.phone, 15)
        FROM users u
        WHERE u.employee_code IS NOT NULL
          AND u.employee_code <> ''
          AND NOT EXISTS (
              SELECT 1 FROM employees e
              WHERE e.employee_code COLLATE utf8mb4_unicode_ci = u.employee_code COLLATE utf8mb4_unicode_ci
          )
    """))
    await conn.execute(text("""
        UPDATE users u
        JOIN employees e
          ON e.employee_code COLLATE utf8mb4_unicode_ci = u.employee_code COLLATE utf8mb4_unicode_ci
        SET u.employee_id = e.id
        WHERE u.employee_id IS NULL
          AND u.employee_code IS NOT NULL
          AND u.employee_code <> ''
    """))


async def ensure_feature_schema(session: AsyncSession) -> None:
    conn = await session.connection()
    await ensure_feature_schema_on_connection(conn)


async def ensure_uom_category_schema(session: AsyncSession) -> None:
    conn = await session.connection()
    await conn.run_sync(UOMCategory.__table__.create, checkfirst=True)

    col_exists = (
        await conn.execute(
            text(
                """
                SELECT 1
                FROM information_schema.columns
                WHERE table_schema = DATABASE()
                  AND table_name = 'uom'
                  AND column_name = 'category_id'
                LIMIT 1
                """
            )
        )
    ).scalar_one_or_none()
    if col_exists is None:
        await conn.execute(text("ALTER TABLE uom ADD COLUMN category_id BIGINT NULL"))

    idx_exists = (
        await conn.execute(
            text(
                """
                SELECT 1
                FROM information_schema.statistics
                WHERE table_schema = DATABASE()
                  AND table_name = 'uom'
                  AND index_name = 'ix_uom_category_id'
                LIMIT 1
                """
            )
        )
    ).scalar_one_or_none()
    if idx_exists is None:
        await conn.execute(text("CREATE INDEX ix_uom_category_id ON uom (category_id)"))


async def ensure_uom_enterprise_schema(session: AsyncSession) -> None:
    conn = await session.connection()
    await ensure_uom_category_schema(session)

    async def has_column(table_name: str, column_name: str) -> bool:
        return (
            await conn.execute(
                text(
                    """
                    SELECT 1
                    FROM information_schema.columns
                    WHERE table_schema = DATABASE()
                      AND table_name = :table_name
                      AND column_name = :column_name
                    LIMIT 1
                    """
                ),
                {"table_name": table_name, "column_name": column_name},
            )
        ).scalar_one_or_none() is not None

    for column_name, ddl in (
        ("base_uom_id", "ALTER TABLE uom_categories ADD COLUMN base_uom_id BIGINT NULL"),
        ("updated_at", "ALTER TABLE uom_categories ADD COLUMN updated_at DATETIME NULL DEFAULT CURRENT_TIMESTAMP"),
    ):
        if not await has_column("uom_categories", column_name):
            await conn.execute(text(ddl))

    if not await has_column("uom", "updated_at"):
        await conn.execute(text("ALTER TABLE uom ADD COLUMN updated_at DATETIME NULL DEFAULT CURRENT_TIMESTAMP"))

    if not await has_column("uom_conversions", "category_id"):
        await conn.execute(text("ALTER TABLE uom_conversions ADD COLUMN category_id BIGINT NULL"))
    if not await has_column("uom_conversions", "factor_num"):
        await conn.execute(text("ALTER TABLE uom_conversions ADD COLUMN factor_num DECIMAL(24,12) NOT NULL DEFAULT 1"))
    if not await has_column("uom_conversions", "factor_den"):
        await conn.execute(text("ALTER TABLE uom_conversions ADD COLUMN factor_den DECIMAL(24,12) NOT NULL DEFAULT 1"))
    if not await has_column("uom_conversions", "valid_from"):
        await conn.execute(text("ALTER TABLE uom_conversions ADD COLUMN valid_from DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP"))
    if not await has_column("uom_conversions", "valid_to"):
        await conn.execute(text("ALTER TABLE uom_conversions ADD COLUMN valid_to DATETIME NULL"))
    if not await has_column("uom_conversions", "is_system"):
        await conn.execute(text("ALTER TABLE uom_conversions ADD COLUMN is_system TINYINT(1) NULL DEFAULT 0"))
    if not await has_column("uom_conversions", "created_at"):
        await conn.execute(text("ALTER TABLE uom_conversions ADD COLUMN created_at DATETIME NULL DEFAULT CURRENT_TIMESTAMP"))
    if not await has_column("uom_conversions", "updated_at"):
        await conn.execute(text("ALTER TABLE uom_conversions ADD COLUMN updated_at DATETIME NULL DEFAULT CURRENT_TIMESTAMP"))

    await conn.execute(
        text(
            """
            UPDATE uom_conversions uc
            JOIN uom u ON u.id = uc.from_uom_id
            SET uc.category_id = u.category_id
            WHERE uc.category_id IS NULL
            """
        )
    )
    await conn.execute(
        text(
            """
            UPDATE uom_conversions
            SET factor_num = conversion_factor, factor_den = 1
            WHERE factor_num = 1 AND factor_den = 1 AND conversion_factor <> 1
            """
        )
    )

    await conn.run_sync(ItemUOMConversion.__table__.create, checkfirst=True)


async def ensure_vendor_type_schema(session: AsyncSession) -> None:
    conn = await session.connection()
    await conn.run_sync(VendorType.__table__.create, checkfirst=True)
    await conn.run_sync(VendorCategory.__table__.create, checkfirst=True)
    await conn.run_sync(VendorVendorType.__table__.create, checkfirst=True)
    await conn.run_sync(VendorItemHistory.__table__.create, checkfirst=True)

    col_exists = (
        await conn.execute(
            text(
                """
                SELECT 1
                FROM information_schema.columns
                WHERE table_schema = DATABASE()
                  AND table_name = 'vendors'
                  AND column_name = 'vendor_type_id'
                LIMIT 1
                """
            )
        )
    ).scalar_one_or_none()
    if col_exists is None:
        await conn.execute(text("ALTER TABLE vendors ADD COLUMN vendor_type_id BIGINT NULL"))

    category_col_exists = (
        await conn.execute(
            text(
                """
                SELECT 1
                FROM information_schema.columns
                WHERE table_schema = DATABASE()
                  AND table_name = 'vendors'
                  AND column_name = 'vendor_category_id'
                LIMIT 1
                """
            )
        )
    ).scalar_one_or_none()
    if category_col_exists is None:
        await conn.execute(text("ALTER TABLE vendors ADD COLUMN vendor_category_id BIGINT NULL"))

    idx_exists = (
        await conn.execute(
            text(
                """
                SELECT 1
                FROM information_schema.statistics
                WHERE table_schema = DATABASE()
                  AND table_name = 'vendors'
                  AND index_name = 'ix_vendors_vendor_type_id'
                LIMIT 1
                """
            )
        )
    ).scalar_one_or_none()
    if idx_exists is None:
        await conn.execute(text("CREATE INDEX ix_vendors_vendor_type_id ON vendors (vendor_type_id)"))

    category_idx_exists = (
        await conn.execute(
            text(
                """
                SELECT 1
                FROM information_schema.statistics
                WHERE table_schema = DATABASE()
                  AND table_name = 'vendors'
                  AND index_name = 'ix_vendors_vendor_category_id'
                LIMIT 1
                """
            )
        )
    ).scalar_one_or_none()
    if category_idx_exists is None:
        await conn.execute(text("CREATE INDEX ix_vendors_vendor_category_id ON vendors (vendor_category_id)"))

    for code, name in (
        ("strategic", "Strategic"),
        ("preferred", "Preferred"),
        ("approved", "Approved"),
        ("conditional", "Conditional"),
        ("blocked", "Blocked"),
    ):
        await conn.execute(
            text(
                """
                INSERT INTO vendor_categories (code, name, is_active, created_at)
                SELECT :code, :name, 1, CURRENT_TIMESTAMP
                WHERE NOT EXISTS (SELECT 1 FROM vendor_categories WHERE code = :code)
                """
            ),
            {"code": code, "name": name},
        )

    for code, name in (
        ("material", "Material Supplier"),
        ("transport", "Transport Vendor"),
        ("service", "Service Provider"),
        ("both", "Material & Service"),
    ):
        await conn.execute(
            text(
                """
                INSERT INTO vendor_types (code, name, is_active, created_at)
                SELECT :code, :name, 1, CURRENT_TIMESTAMP
                WHERE NOT EXISTS (SELECT 1 FROM vendor_types WHERE code = :code)
                """
            ),
            {"code": code, "name": name},
        )

    await conn.execute(
        text(
            """
            UPDATE vendors v
            JOIN vendor_types vt
              ON vt.code COLLATE utf8mb4_unicode_ci = v.vendor_type COLLATE utf8mb4_unicode_ci
            SET v.vendor_type_id = vt.id
            WHERE v.vendor_type_id IS NULL
            """
        )
    )
    await conn.execute(
        text(
            """
            INSERT IGNORE INTO vendor_vendor_types (vendor_id, vendor_type_id, created_at)
            SELECT v.id, v.vendor_type_id, CURRENT_TIMESTAMP
            FROM vendors v
            WHERE v.vendor_type_id IS NOT NULL
            """
        )
    )





async def ensure_item_category_code_schema(session: AsyncSession) -> None:
    conn = await session.connection()
    for column_name, ddl in (
        ("short_code", "ALTER TABLE item_categories ADD COLUMN short_code VARCHAR(2) NULL"),
        ("full_code", "ALTER TABLE item_categories ADD COLUMN full_code VARCHAR(6) NULL"),
    ):
        col_exists = (
            await conn.execute(
                text(
                    """
                    SELECT 1
                    FROM information_schema.columns
                    WHERE table_schema = DATABASE()
                      AND table_name = 'item_categories'
                      AND column_name = :column_name
                    LIMIT 1
                    """
                ),
                {"column_name": column_name},
            )
        ).scalar_one_or_none()
        if col_exists is None:
            await conn.execute(text(ddl))

    missing_codes = (
        await conn.execute(
            text(
                """
                SELECT id, parent_id, name, code, code_prefix, short_code, full_code
                FROM item_categories
                WHERE short_code IS NULL OR full_code IS NULL
                ORDER BY parent_id, name, id
                """
            )
        )
    ).mappings().all()
    if missing_codes:
        rows = (
            await conn.execute(
                text("SELECT id, parent_id, name, code, code_prefix, short_code, full_code FROM item_categories ORDER BY parent_id, name, id")
            )
        ).mappings().all()
        items = [dict(row) for row in rows]
        by_id = {row["id"]: row for row in items}
        siblings: dict[int | None, list[dict]] = {}
        for row in items:
            siblings.setdefault(row.get("parent_id"), []).append(row)

        def derive_short(row: dict) -> str:
            if row.get("short_code"):
                return row["short_code"]
            for raw in (row.get("code_prefix"), row.get("code")):
                match = re.search(r"\d{2}", str(raw or ""))
                if match and 10 <= int(match.group(0)) <= 99:
                    return match.group(0)
            ordered = sorted(siblings.get(row.get("parent_id"), []), key=lambda r: ((r.get("name") or ""), r["id"]))
            for idx, sibling in enumerate(ordered, start=10):
                if sibling["id"] == row["id"]:
                    return f"{idx:02d}" if idx <= 99 else None
            return None

        for row in items:
            row["short_code"] = derive_short(row)

        def derive_full(row: dict) -> str:
            if row.get("full_code"):
                return row["full_code"]
            parent = by_id.get(row.get("parent_id"))
            if not row.get("short_code"):
                row["full_code"] = None
            elif parent and parent.get("full_code"):
                row["full_code"] = f"{derive_full(parent)}{row['short_code']}"[:6]
            elif parent:
                row["full_code"] = None
            else:
                row["full_code"] = row["short_code"]
            return row["full_code"]

        used = set()
        for row in items:
            full_code = derive_full(row)
            if full_code and full_code in used:
                base = full_code[:-2] if len(full_code) > 2 else ""
                suffix = 10
                while f"{base}{suffix:02d}" in used and suffix <= 99:
                    suffix += 1
                if suffix <= 99:
                    row["short_code"] = f"{suffix:02d}"
                    row["full_code"] = f"{base}{row['short_code']}"
                else:
                    row["short_code"] = None
                    row["full_code"] = None
            if row["full_code"]:
                used.add(row["full_code"])
            await conn.execute(
                text("UPDATE item_categories SET short_code = :short_code, full_code = :full_code WHERE id = :id"),
                {"id": row["id"], "short_code": row["short_code"], "full_code": row["full_code"]},
            )

    idx_exists = (
        await conn.execute(
            text(
                """
                SELECT 1
                FROM information_schema.statistics
                WHERE table_schema = DATABASE()
                  AND table_name = 'item_categories'
                  AND index_name = 'ix_item_categories_full_code'
                LIMIT 1
                """
            )
        )
    ).scalar_one_or_none()
    if idx_exists is None:
        await conn.execute(text("CREATE UNIQUE INDEX ix_item_categories_full_code ON item_categories (full_code)"))


async def ensure_item_attribute_uom_schema(session: AsyncSession) -> None:
    conn = await session.connection()
    await ensure_uom_category_schema(session)

    for table_name in ("item_attributes", "item_attribute_values"):
        col_exists = (
            await conn.execute(
                text(
                    """
                    SELECT 1
                    FROM information_schema.columns
                    WHERE table_schema = DATABASE()
                      AND table_name = :table_name
                      AND column_name = 'uom_category_id'
                    LIMIT 1
                    """
                ),
                {"table_name": table_name},
            )
        ).scalar_one_or_none()
        if col_exists is None:
            await conn.execute(text(f"ALTER TABLE {table_name} ADD COLUMN uom_category_id BIGINT NULL"))

        idx_exists = (
            await conn.execute(
                text(
                    """
                    SELECT 1
                    FROM information_schema.statistics
                    WHERE table_schema = DATABASE()
                      AND table_name = :table_name
                      AND index_name = :index_name
                    LIMIT 1
                    """
                ),
                {"table_name": table_name, "index_name": f"ix_{table_name}_uom_category_id"},
            )
        ).scalar_one_or_none()
        if idx_exists is None:
            await conn.execute(
                text(f"CREATE INDEX ix_{table_name}_uom_category_id ON {table_name} (uom_category_id)")
            )


async def ensure_item_uom_category_schema(session: AsyncSession) -> None:
    conn = await session.connection()
    await ensure_uom_category_schema(session)

    col_exists = (
        await conn.execute(
            text(
                """
                SELECT 1
                FROM information_schema.columns
                WHERE table_schema = DATABASE()
                  AND table_name = 'items'
                  AND column_name = 'uom_category_id'
                LIMIT 1
                """
            )
        )
    ).scalar_one_or_none()
    if col_exists is None:
        await conn.execute(text("ALTER TABLE items ADD COLUMN uom_category_id BIGINT NULL"))

    idx_exists = (
        await conn.execute(
            text(
                """
                SELECT 1
                FROM information_schema.statistics
                WHERE table_schema = DATABASE()
                  AND table_name = 'items'
                  AND index_name = 'ix_items_uom_category_id'
                LIMIT 1
                """
            )
        )
    ).scalar_one_or_none()
    if idx_exists is None:
        await conn.execute(text("CREATE INDEX ix_items_uom_category_id ON items (uom_category_id)"))


async def ensure_specs_schema(session: AsyncSession) -> None:
    conn = await session.connection()
    await ensure_uom_category_schema(session)
    for table in (SpecCategory.__table__, Spec.__table__, ItemSpec.__table__, ItemSpecValue.__table__):
        await conn.run_sync(table.create, checkfirst=True)


async def ensure_feature_schema_on_connection(conn: AsyncConnection) -> None:
    # Create new master table when missing.
    await conn.run_sync(Feature.__table__.create, checkfirst=True)
    await conn.run_sync(ItemFeature.__table__.create, checkfirst=True)

    # Add items.feature_id for legacy DBs that predate this field.
    col_exists = (
        await conn.execute(
            text(
                """
                SELECT 1
                FROM information_schema.columns
                WHERE table_schema = DATABASE()
                  AND table_name = 'items'
                  AND column_name = 'feature_id'
                LIMIT 1
                """
            )
        )
    ).scalar_one_or_none()
    if col_exists is None:
        await conn.execute(text("ALTER TABLE items ADD COLUMN feature_id BIGINT NULL"))

    idx_exists = (
        await conn.execute(
            text(
                """
                SELECT 1
                FROM information_schema.statistics
                WHERE table_schema = DATABASE()
                  AND table_name = 'items'
                  AND index_name = 'idx_items_feature_id'
                LIMIT 1
                """
            )
        )
    ).scalar_one_or_none()
    if idx_exists is None:
        await conn.execute(text("CREATE INDEX idx_items_feature_id ON items (feature_id)"))

    map_idx_exists = (
        await conn.execute(
            text(
                """
                SELECT 1
                FROM information_schema.statistics
                WHERE table_schema = DATABASE()
                  AND table_name = 'item_features'
                  AND index_name = 'ux_item_features_item_feature'
                LIMIT 1
                """
            )
        )
    ).scalar_one_or_none()
    if map_idx_exists is None:
        await conn.execute(
            text("CREATE UNIQUE INDEX ux_item_features_item_feature ON item_features (item_id, feature_id)")
        )


async def ensure_packaging_schema(session: AsyncSession) -> None:
    conn = await session.connection()
    await conn.run_sync(PackagingLevel.__table__.create, checkfirst=True)
    await conn.run_sync(ItemPackaging.__table__.create, checkfirst=True)
    
    # Backfill levels if missing
    from sqlalchemy import select
    existing_levels = await session.execute(select(PackagingLevel))
    if not existing_levels.scalars().all():
        levels = [
            PackagingLevel(level_name="Unit", level_order=1),
            PackagingLevel(level_name="Strip", level_order=2),
            PackagingLevel(level_name="Box", level_order=3),
            PackagingLevel(level_name="Carton", level_order=4),
        ]
        session.add_all(levels)
        await session.flush()


async def ensure_material_issue_schema(session: AsyncSession) -> None:
    conn = await session.connection()
    columns = {
        row[0]
        for row in (await conn.execute(text("""
            SELECT column_name
            FROM information_schema.columns
            WHERE table_schema = DATABASE()
              AND table_name = 'material_issues'
        """))).all()
    }

    if "dispatched_at" not in columns:
        await conn.execute(text("ALTER TABLE material_issues ADD COLUMN dispatched_at DATETIME NULL"))

    try:
        await conn.execute(text("""
            ALTER TABLE material_issues 
            MODIFY COLUMN status ENUM('draft', 'issued', 'dispatched', 'acknowledged', 'completed', 'cancelled') DEFAULT 'draft'
        """))
    except Exception:
        pass

    items_columns = {
        row[0]
        for row in (await conn.execute(text("""
            SELECT column_name
            FROM information_schema.columns
            WHERE table_schema = DATABASE()
              AND table_name = 'material_issue_items'
        """))).all()
    }
    if "serial_numbers" not in items_columns:
        await conn.execute(text("ALTER TABLE material_issue_items ADD COLUMN serial_numbers JSON NULL"))


async def ensure_logistics_so_schema(session: AsyncSession) -> None:
    conn = await session.connection()
    columns = {
        row[0]
        for row in (await conn.execute(text("""
            SELECT column_name
            FROM information_schema.columns
            WHERE table_schema = DATABASE()
              AND table_name = 'logistics_service_orders'
        """))).all()
    }

    if "arrival_date" not in columns:
        await conn.execute(text("ALTER TABLE logistics_service_orders ADD COLUMN arrival_date VARCHAR(50) NULL"))
    if "expected_delivery_date" not in columns:
        await conn.execute(text("ALTER TABLE logistics_service_orders ADD COLUMN expected_delivery_date DATETIME NULL"))

    columns_rfq = {
        row[0]
        for row in (await conn.execute(text("""
            SELECT column_name
            FROM information_schema.columns
            WHERE table_schema = DATABASE()
              AND table_name = 'logistics_rfq_masters'
        """))).all()
    }

    if "expected_delivery_date" not in columns_rfq:
        await conn.execute(text("ALTER TABLE logistics_rfq_masters ADD COLUMN expected_delivery_date DATETIME NULL"))


async def ensure_universal_dispatch_ack_schema(session: AsyncSession) -> None:
    conn = await session.connection()
    
    from app.models.dispatch import (
        DispatchDeliveryAcknowledgement, 
        DispatchAcknowledgementItem, 
        DispatchAcknowledgementDocument,
        DispatchOrderItem
    )
    await conn.run_sync(DispatchDeliveryAcknowledgement.__table__.create, checkfirst=True)
    await conn.run_sync(DispatchAcknowledgementItem.__table__.create, checkfirst=True)
    await conn.run_sync(DispatchAcknowledgementDocument.__table__.create, checkfirst=True)
    await conn.run_sync(DispatchOrderItem.__table__.create, checkfirst=True)

    # Safe dropping of legacy tables
    try:
        await conn.execute(text("DROP TABLE IF EXISTS dispatch_item"))
        await conn.execute(text("DROP TABLE IF EXISTS dispatch_header"))
    except Exception:
        pass

    columns = {
        row[0]
        for row in (await conn.execute(text("""
            SELECT column_name
            FROM information_schema.columns
            WHERE table_schema = DATABASE()
              AND table_name = 'dispatch_orders'
        """))).all()
    }

    if "destination_warehouse_id" not in columns:
        await conn.execute(text("ALTER TABLE dispatch_orders ADD COLUMN destination_warehouse_id BIGINT NULL"))
    if "expected_delivery_date" not in columns:
        await conn.execute(text("ALTER TABLE dispatch_orders ADD COLUMN expected_delivery_date DATETIME NULL"))
    if "destination_user_id" not in columns:
        await conn.execute(text("ALTER TABLE dispatch_orders ADD COLUMN destination_user_id BIGINT NULL"))
    if "destination_type" not in columns:
        await conn.execute(text("ALTER TABLE dispatch_orders ADD COLUMN destination_type VARCHAR(50) NOT NULL DEFAULT 'USER'"))
    if "dispatch_type" not in columns:
        await conn.execute(text("ALTER TABLE dispatch_orders ADD COLUMN dispatch_type VARCHAR(50) NOT NULL DEFAULT 'THIRD_PARTY'"))
    if "delivery_acknowledged" not in columns:
        await conn.execute(text("ALTER TABLE dispatch_orders ADD COLUMN delivery_acknowledged TINYINT(1) NOT NULL DEFAULT 0"))
    if "delivery_acknowledged_at" not in columns:
        await conn.execute(text("ALTER TABLE dispatch_orders ADD COLUMN delivery_acknowledged_at DATETIME NULL"))
    if "delivery_acknowledged_by_id" not in columns:
        await conn.execute(text("ALTER TABLE dispatch_orders ADD COLUMN delivery_acknowledged_by_id BIGINT NULL"))
    if "delivery_acknowledged_by_name" not in columns:
        await conn.execute(text("ALTER TABLE dispatch_orders ADD COLUMN delivery_acknowledged_by_name VARCHAR(100) NULL"))
    if "delivery_acknowledged_by_designation" not in columns:
        await conn.execute(text("ALTER TABLE dispatch_orders ADD COLUMN delivery_acknowledged_by_designation VARCHAR(100) NULL"))
    if "delivery_acknowledged_by_phone" not in columns:
        await conn.execute(text("ALTER TABLE dispatch_orders ADD COLUMN delivery_acknowledged_by_phone VARCHAR(20) NULL"))
    if "delivery_acknowledged_by_email" not in columns:
        await conn.execute(text("ALTER TABLE dispatch_orders ADD COLUMN delivery_acknowledged_by_email VARCHAR(100) NULL"))
    if "receiver_signature_url" not in columns:
        await conn.execute(text("ALTER TABLE dispatch_orders ADD COLUMN receiver_signature_url VARCHAR(500) NULL"))
    if "receiver_id_proof_type" not in columns:
        await conn.execute(text("ALTER TABLE dispatch_orders ADD COLUMN receiver_id_proof_type VARCHAR(50) NOT NULL DEFAULT 'NONE'"))
    if "receiver_id_proof_number" not in columns:
        await conn.execute(text("ALTER TABLE dispatch_orders ADD COLUMN receiver_id_proof_number VARCHAR(50) NULL"))
    if "delivery_photo_urls" not in columns:
        await conn.execute(text("ALTER TABLE dispatch_orders ADD COLUMN delivery_photo_urls JSON NULL"))
    if "goods_condition_on_delivery" not in columns:
        await conn.execute(text("ALTER TABLE dispatch_orders ADD COLUMN goods_condition_on_delivery VARCHAR(50) NOT NULL DEFAULT 'GOOD'"))
    if "delivery_remarks" not in columns:
        await conn.execute(text("ALTER TABLE dispatch_orders ADD COLUMN delivery_remarks TEXT NULL"))
    if "material_issue_id" not in columns:
        await conn.execute(text("ALTER TABLE dispatch_orders ADD COLUMN material_issue_id BIGINT NULL"))
    if "delivery_location_latitude" not in columns:
        await conn.execute(text("ALTER TABLE dispatch_orders ADD COLUMN delivery_location_latitude DECIMAL(10, 8) NULL"))
    if "delivery_location_longitude" not in columns:
        await conn.execute(text("ALTER TABLE dispatch_orders ADD COLUMN delivery_location_longitude DECIMAL(11, 8) NULL"))
    if "delivery_location_verified" not in columns:
        await conn.execute(text("ALTER TABLE dispatch_orders ADD COLUMN delivery_location_verified TINYINT(1) NOT NULL DEFAULT 0"))
    
    try:
        await conn.execute(text("""
            ALTER TABLE dispatch_orders 
            MODIFY COLUMN status ENUM(
                'draft', 'loading', 'loaded', 'dispatched', 'in_transit',
                'out_for_delivery', 'delivered', 'acknowledged',
                'partially_acknowledged', 'rejected', 'returned', 'cancelled'
            ) DEFAULT 'draft'
        """))
    except Exception:
        pass

    items_cols = {
        row[0]
        for row in (await conn.execute(text("""
            SELECT column_name
            FROM information_schema.columns
            WHERE table_schema = DATABASE()
              AND table_name = 'dispatch_order_items'
        """))).all()
    }
    if "serial_numbers" not in items_cols:
        await conn.execute(text("ALTER TABLE dispatch_order_items ADD COLUMN serial_numbers JSON NULL"))


