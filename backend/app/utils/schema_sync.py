import re

_BOOTSTRAP_STATE = {}

def _should_sync(name: str) -> bool:
    if _BOOTSTRAP_STATE.get(name):
        return False
    _BOOTSTRAP_STATE[name] = True
    return True


from sqlalchemy import text
from sqlalchemy.exc import OperationalError
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncSession

from app.models.master import Feature, ItemFeature, UOMCategory, UOMConversion, ItemUOMConversion, VendorType, VendorCategory, VendorVendorType, VendorItemHistory, SpecCategory, Spec, ItemSpec, ItemSpecValue, Office, Position, Employee, UserItemPermission, RoleItemPermission, PackagingLevel, ItemPackaging
from app.models.vendor_portal import VendorUser
from app.models.user import ApiKey, TokenBlocklist, PasswordHistory
from app.models.consignment import (
    Consignment, ConsignmentPackage, ConsignmentPackageItem,
    ConsignmentPackageContainer, ConsignmentPackageAcknowledgement,
    ConsignmentParentPackage, ConsignmentParentPackageChild,
)


async def ensure_api_keys_schema(session: AsyncSession) -> None:
    """Create api_keys, token_blocklist and password_history tables if they
    do not exist yet. This fixes the 503 Service Unavailable that occurs
    when the backend is deployed to a fresh database that has never had
    these tables created via an Alembic migration.
    """
    if not _should_sync("api_keys_schema"):
        return
    conn = await session.connection()
    await conn.run_sync(TokenBlocklist.__table__.create, checkfirst=True)
    await conn.run_sync(PasswordHistory.__table__.create, checkfirst=True)
    await conn.run_sync(ApiKey.__table__.create, checkfirst=True)


async def ensure_consignment_schema(session: AsyncSession) -> None:
    """Create consignment pipeline tables if they do not exist.

    Tables created (in dependency order):
      consignments
      consignment_packages
      consignment_package_items
      consignment_package_containers
      consignment_package_acknowledgements

    Also ensures the 'delivered' value exists in the mi_status_enum on the
    material_issues table so consignment acknowledgement can flip MI status.
    """
    if not _should_sync("consignment_schema"):
        return
    conn = await session.connection()
    await conn.run_sync(Consignment.__table__.create, checkfirst=True)
    await conn.run_sync(ConsignmentPackage.__table__.create, checkfirst=True)
    await conn.run_sync(ConsignmentPackageItem.__table__.create, checkfirst=True)
    await conn.run_sync(ConsignmentPackageContainer.__table__.create, checkfirst=True)
    await conn.run_sync(ConsignmentPackageAcknowledgement.__table__.create, checkfirst=True)
    await conn.run_sync(ConsignmentParentPackage.__table__.create, checkfirst=True)
    await conn.run_sync(ConsignmentParentPackageChild.__table__.create, checkfirst=True)

    # Add 'delivered' to mi_status_enum if not present (MySQL ALTER COLUMN)
    try:
        await conn.execute(text("""
            ALTER TABLE material_issues
            MODIFY COLUMN status ENUM(
                'draft','issued','dispatched','acknowledged',
                'completed','cancelled','delivered','received','partially_acknowledged'
            ) DEFAULT 'draft'
        """))
    except Exception:
        pass  # already exists or DB doesn't need it

    # Sync new consignment parent package columns if missing
    try:
        columns = {
            row[0]
            for row in (await conn.execute(text("""
                SELECT column_name
                FROM information_schema.columns
                WHERE table_schema = DATABASE()
                  AND table_name = 'consignments'
            """))).all()
        }
        if "parent_package_code" not in columns:
            await conn.execute(text("ALTER TABLE consignments ADD COLUMN parent_package_code VARCHAR(100) NULL"))
        if "parent_package_barcode" not in columns:
            await conn.execute(text("ALTER TABLE consignments ADD COLUMN parent_package_barcode VARCHAR(500) NULL"))
        if "receiver_position_code" not in columns:
            await conn.execute(text("ALTER TABLE consignments ADD COLUMN receiver_position_code VARCHAR(100) NULL"))
        if "receipt_signature_url" not in columns:
            await conn.execute(text("ALTER TABLE consignments ADD COLUMN receipt_signature_url VARCHAR(500) NULL"))
        if "receipt_photos" not in columns:
            await conn.execute(text("ALTER TABLE consignments ADD COLUMN receipt_photos JSON NULL"))
        if "receipt_remarks" not in columns:
            await conn.execute(text("ALTER TABLE consignments ADD COLUMN receipt_remarks TEXT NULL"))
    except Exception:
        pass

    try:
        pkg_columns = {
            row[0]
            for row in (await conn.execute(text("""
                SELECT column_name
                FROM information_schema.columns
                WHERE table_schema = DATABASE()
                  AND table_name = 'consignment_packages'
            """))).all()
        }
        if "parent_package_code" not in pkg_columns:
            await conn.execute(text("ALTER TABLE consignment_packages ADD COLUMN parent_package_code VARCHAR(100) NULL"))
        if "parent_package_barcode" not in pkg_columns:
            await conn.execute(text("ALTER TABLE consignment_packages ADD COLUMN parent_package_barcode VARCHAR(500) NULL"))
    except Exception:
        pass



async def ensure_user_item_permission_schema(session: AsyncSession) -> None:
    if not _should_sync("user_item_permission_schema"):
        return
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
    if not _should_sync("supplier_portal_schema"):
        return
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
    if not _should_sync("rfq_schema"):
        return
    conn = await session.connection()

    from app.models.procurement import RFQ, RFQItem, RFQVendor
    await conn.run_sync(RFQ.__table__.create, checkfirst=True)
    await conn.run_sync(RFQItem.__table__.create, checkfirst=True)
    await conn.run_sync(RFQVendor.__table__.create, checkfirst=True)

    rfq_columns = {
        row[0]
        for row in (await conn.execute(text("""
            SELECT column_name
            FROM information_schema.columns
            WHERE table_schema = DATABASE()
              AND table_name = 'rfqs'
        """))).all()
    }
    if "terms_url" not in rfq_columns:
        await conn.execute(text("ALTER TABLE rfqs ADD COLUMN terms_url VARCHAR(500) NULL"))

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
    if "terms_url" not in quotation_columns:
        await conn.execute(text("ALTER TABLE quotations ADD COLUMN terms_url VARCHAR(500) NULL"))

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

    if "version_number" not in po_columns:
        try:
            await conn.execute(text("ALTER TABLE purchase_orders ADD COLUMN version_number VARCHAR(20) NOT NULL DEFAULT '1.0'"))
        except Exception:
            pass
    if "parent_po_id" not in po_columns:
        try:
            await conn.execute(text("ALTER TABLE purchase_orders ADD COLUMN parent_po_id BIGINT, ADD CONSTRAINT fk_parent_po_id FOREIGN KEY (parent_po_id) REFERENCES purchase_orders(id)"))
        except Exception:
            pass
    if "supplier_delivery_date" not in po_columns:
        try:
            await conn.execute(text("ALTER TABLE purchase_orders ADD COLUMN supplier_delivery_date DATETIME"))
        except Exception:
            pass
    if "is_current" not in po_columns:
        try:
            await conn.execute(text("ALTER TABLE purchase_orders ADD COLUMN is_current TINYINT(1) NOT NULL DEFAULT 1"))
        except Exception:
            pass
    if "base_po_number" not in po_columns:
        try:
            await conn.execute(text("ALTER TABLE purchase_orders ADD COLUMN base_po_number VARCHAR(50)"))
        except Exception:
            pass

    try:
        await conn.execute(text("""
            ALTER TABLE purchase_orders 
            MODIFY COLUMN status ENUM('draft', 'pending_approval', 'approved', 'accepted', 'rejected', 'partially_received', 'received', 'closed', 'cancelled') NOT NULL DEFAULT 'draft'
        """))
    except Exception:
        pass


async def ensure_organization_structure_schema(session: AsyncSession) -> None:
    if not _should_sync("organization_structure_schema"):
        return
    conn = await session.connection()
    await conn.run_sync(Office.__table__.create, checkfirst=True)
    await conn.run_sync(Position.__table__.create, checkfirst=True)
    await conn.run_sync(Employee.__table__.create, checkfirst=True)

    # Ensure position_reporting junction table exists
    try:
        await conn.execute(text("""
            CREATE TABLE IF NOT EXISTS position_reporting (
                position_id BIGINT NOT NULL,
                parent_position_id BIGINT NOT NULL,
                PRIMARY KEY (position_id, parent_position_id),
                CONSTRAINT fk_pos_rep_position FOREIGN KEY (position_id) REFERENCES positions(id) ON DELETE CASCADE,
                CONSTRAINT fk_pos_rep_parent FOREIGN KEY (parent_position_id) REFERENCES positions(id) ON DELETE CASCADE
            )
        """))
    except Exception as exc:
        print(f"Ignored error creating position_reporting table: {exc}")

    # Wave 11C — add HRMS API extra columns if missing
    for col_name, col_ddl in (
        ("job_name", "ALTER TABLE positions ADD COLUMN job_name VARCHAR(100) NULL"),
        ("job_family_name", "ALTER TABLE positions ADD COLUMN job_family_name VARCHAR(100) NULL"),
        ("job_family_id", "ALTER TABLE positions ADD COLUMN job_family_id BIGINT NULL"),
        ("role_type_id", "ALTER TABLE positions ADD COLUMN role_type_id BIGINT NULL"),
        ("status", "ALTER TABLE positions ADD COLUMN status VARCHAR(50) DEFAULT 'active'"),
        ("start_date", "ALTER TABLE positions ADD COLUMN start_date DATETIME NULL"),
        ("hire_date", "ALTER TABLE employees ADD COLUMN hire_date DATE NULL"),
        ("bank_details", "ALTER TABLE employees ADD COLUMN bank_details JSON NULL"),
    ):
        col_check = (await conn.execute(text("""
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = DATABASE() AND table_name = :table AND column_name = :col
            LIMIT 1
        """), {"table": "positions" if col_name != "hire_date" and col_name != "bank_details" else "employees",
                "col": col_name})).scalar_one_or_none()
        if col_check is None:
            tab = "positions" if col_name not in ("hire_date", "bank_details") else "employees"
            try:
                await conn.execute(text(col_ddl))
            except Exception:
                pass

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

    position_emp_exists = (await conn.execute(text("""
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = DATABASE()
          AND table_name = 'positions'
          AND column_name = 'employee_id'
        LIMIT 1
    """))).scalar_one_or_none()
    if position_emp_exists is None:
        await conn.execute(text("ALTER TABLE positions ADD COLUMN employee_id BIGINT NULL"))

    position_emp_fk_exists = (await conn.execute(text("""
        SELECT 1
        FROM information_schema.key_column_usage
        WHERE table_schema = DATABASE()
          AND table_name = 'positions'
          AND column_name = 'employee_id'
          AND referenced_table_name = 'employees'
        LIMIT 1
    """))).scalar_one_or_none()
    if position_emp_fk_exists is None:
        try:
            await conn.execute(text("""
                ALTER TABLE positions
                ADD CONSTRAINT fk_positions_employee_id
                FOREIGN KEY (employee_id) REFERENCES employees (id)
                ON DELETE SET NULL
            """))
        except Exception as exc:
            print(f"Ignored index/fk error: {exc}")

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

    # Sync warehouse.office_id column and FK
    warehouse_office_exists = (await conn.execute(text("""
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = DATABASE()
          AND table_name = 'warehouses'
          AND column_name = 'office_id'
        LIMIT 1
    """))).scalar_one_or_none()
    if warehouse_office_exists is None:
        await conn.execute(text("ALTER TABLE warehouses ADD COLUMN office_id BIGINT NULL"))
        try:
            await conn.execute(text("""
                ALTER TABLE warehouses
                ADD CONSTRAINT fk_warehouses_office_id
                FOREIGN KEY (office_id) REFERENCES offices (id)
                ON DELETE SET NULL
            """))
        except Exception as exc:
            print(f"Ignored fk_warehouses_office_id error: {exc}")

    # ── Speed-search indexes for positions, employees, offices ────────────
    # B-tree indexes on frequently filtered/joined columns
    _search_indexes = (
        # positions
        ("idx_positions_name", "CREATE INDEX idx_positions_name ON positions (name)"),
        ("idx_positions_department", "CREATE INDEX idx_positions_department ON positions (department)"),
        ("idx_positions_role_name", "CREATE INDEX idx_positions_role_name ON positions (role_name)"),
        ("idx_positions_status", "CREATE INDEX idx_positions_status ON positions (status)"),
        ("idx_positions_project_id", "CREATE INDEX idx_positions_project_id ON positions (project_id)"),
        ("idx_positions_office_id", "CREATE INDEX idx_positions_office_id ON positions (office_id)"),
        # employees
        ("idx_employees_name", "CREATE INDEX idx_employees_name ON employees (name)"),
        ("idx_employees_email", "CREATE INDEX idx_employees_email ON employees (email)"),
        ("idx_employees_phone", "CREATE INDEX idx_employees_phone ON employees (phone)"),
        ("idx_employees_status", "CREATE INDEX idx_employees_status ON employees (status)"),
        # offices
        ("idx_offices_state", "CREATE INDEX idx_offices_state ON offices (state)"),
        ("idx_offices_district", "CREATE INDEX idx_offices_district ON offices (district)"),
        ("idx_offices_cluster", "CREATE INDEX idx_offices_cluster ON offices (cluster)"),
        # projects
        ("idx_projects_name", "CREATE INDEX idx_projects_name ON projects (name)"),
        # roles
        ("idx_roles_name", "CREATE INDEX idx_roles_name ON roles (name)"),
        # warehouses
        ("idx_warehouses_office_id", "CREATE INDEX idx_warehouses_office_id ON warehouses (office_id)"),
    )
    existing_indexes = {
        row[0]
        for row in (await conn.execute(text("""
            SELECT DISTINCT index_name
            FROM information_schema.statistics
            WHERE table_schema = DATABASE()
              AND table_name IN ('positions', 'employees', 'offices', 'projects', 'roles', 'warehouses')
        """))).all()
    }
    for idx_name, ddl in _search_indexes:
        if idx_name not in existing_indexes:
            try:
                await conn.execute(text(ddl))
            except OperationalError as exc:
                if "Duplicate key name" not in str(exc):
                    raise
                # Index was just created by a concurrent process
                pass


async def ensure_feature_schema(session: AsyncSession) -> None:
    if not _should_sync("feature_schema"):
        return
    conn = await session.connection()
    await ensure_feature_schema_on_connection(conn)


async def ensure_uom_category_schema(session: AsyncSession) -> None:
    if not _should_sync("uom_category_schema"):
        return
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
    if not _should_sync("uom_enterprise_schema"):
        return
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
    if not _should_sync("vendor_type_schema"):
        return
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
    if not _should_sync("item_category_code_schema"):
        return
    conn = await session.connection()
    readable_col_exists = (
        await conn.execute(
            text(
                """
                SELECT 1
                FROM information_schema.columns
                WHERE table_schema = DATABASE()
                  AND table_name = 'items'
                  AND column_name = 'readable_code'
                LIMIT 1
                """
            )
        )
    ).scalar_one_or_none()
    if readable_col_exists is None:
        await conn.execute(text("ALTER TABLE items ADD COLUMN readable_code VARCHAR(255) NULL"))

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
    if not _should_sync("item_attribute_uom_schema"):
        return
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
    if not _should_sync("item_uom_category_schema"):
        return
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

    # Check and add the 12 new fields for special storage and transport conditions
    items_cols = {
        row[0]
        for row in (await conn.execute(text("""
            SELECT column_name
            FROM information_schema.columns
            WHERE table_schema = DATABASE()
              AND table_name = 'items'
        """))).all()
    }

    new_cols = {
        "asset_code": "ALTER TABLE items ADD COLUMN asset_code VARCHAR(100) NULL",
        "consumable_code": "ALTER TABLE items ADD COLUMN consumable_code VARCHAR(100) NULL",
        "special_storage_condition": "ALTER TABLE items ADD COLUMN special_storage_condition TINYINT(1) NOT NULL DEFAULT 0",
        "storage_min_temp": "ALTER TABLE items ADD COLUMN storage_min_temp DECIMAL(5, 2) NULL",
        "storage_max_temp": "ALTER TABLE items ADD COLUMN storage_max_temp DECIMAL(5, 2) NULL",
        "storage_min_moisture": "ALTER TABLE items ADD COLUMN storage_min_moisture DECIMAL(5, 2) NULL",
        "storage_max_moisture": "ALTER TABLE items ADD COLUMN storage_max_moisture DECIMAL(5, 2) NULL",
        "storage_breakable": "ALTER TABLE items ADD COLUMN storage_breakable TINYINT(1) NOT NULL DEFAULT 0",
        "special_transport_condition": "ALTER TABLE items ADD COLUMN special_transport_condition TINYINT(1) NOT NULL DEFAULT 0",
        "transport_min_temp": "ALTER TABLE items ADD COLUMN transport_min_temp DECIMAL(5, 2) NULL",
        "transport_max_temp": "ALTER TABLE items ADD COLUMN transport_max_temp DECIMAL(5, 2) NULL",
        "transport_min_moisture": "ALTER TABLE items ADD COLUMN transport_min_moisture DECIMAL(5, 2) NULL",
        "transport_max_moisture": "ALTER TABLE items ADD COLUMN transport_max_moisture DECIMAL(5, 2) NULL",
        "transport_breakable": "ALTER TABLE items ADD COLUMN transport_breakable TINYINT(1) NOT NULL DEFAULT 0",
    }

    for col, ddl in new_cols.items():
        if col not in items_cols:
            try:
                await conn.execute(text(ddl))
            except Exception as exc:
                print(f"Failed to add column {col} to items: {exc}")


async def ensure_specs_schema(session: AsyncSession) -> None:
    if not _should_sync("specs_schema"):
        return
    conn = await session.connection()
    await ensure_uom_category_schema(session)
    for table in (SpecCategory.__table__, Spec.__table__, ItemSpec.__table__, ItemSpecValue.__table__):
        await conn.run_sync(table.create, checkfirst=True)


async def ensure_feature_schema_on_connection(conn: AsyncConnection) -> None:
    if not _should_sync("feature_schema_on_connection"):
        return
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
    if not _should_sync("packaging_schema"):
        return
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
    if not _should_sync("material_issue_schema"):
        return
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
    if "vehicle_code" not in columns:
        await conn.execute(text("ALTER TABLE material_issues ADD COLUMN vehicle_code VARCHAR(50) NULL"))
    if "vehicle_number" not in columns:
        await conn.execute(text("ALTER TABLE material_issues ADD COLUMN vehicle_number VARCHAR(50) NULL"))
    if "service_code" not in columns:
        await conn.execute(text("ALTER TABLE material_issues ADD COLUMN service_code VARCHAR(50) NULL"))
    if "template_type" not in columns:
        await conn.execute(text("ALTER TABLE material_issues ADD COLUMN template_type VARCHAR(50) NULL"))
    if "project_id" not in columns:
        await conn.execute(text("ALTER TABLE material_issues ADD COLUMN project_id BIGINT NULL"))
        try:
            await conn.execute(text("ALTER TABLE material_issues ADD CONSTRAINT fk_material_issues_project_id FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE SET NULL"))
        except Exception:
            pass

    try:
        await conn.execute(text("""
            ALTER TABLE material_issues 
            MODIFY COLUMN status ENUM('draft', 'issued', 'dispatched', 'acknowledged', 'completed', 'cancelled', 'delivered', 'received', 'partially_acknowledged') DEFAULT 'draft'
        """))
    except Exception:
        pass

    # Ensure indents table has service_code column
    indent_columns = {
        row[0]
        for row in (await conn.execute(text("""
            SELECT column_name
            FROM information_schema.columns
            WHERE table_schema = DATABASE()
              AND table_name = 'indents'
        """))).all()
    }
    if "service_code" not in indent_columns:
        await conn.execute(text("ALTER TABLE indents ADD COLUMN service_code VARCHAR(50) NULL"))

    # Ensure vehicles table has is_active, created_at, updated_at columns
    vehicle_columns = {
        row[0]
        for row in (await conn.execute(text("""
            SELECT column_name
            FROM information_schema.columns
            WHERE table_schema = DATABASE()
              AND table_name = 'vehicles'
        """))).all()
    }
    if "is_active" not in vehicle_columns:
        await conn.execute(text("ALTER TABLE vehicles ADD COLUMN is_active TINYINT(1) NOT NULL DEFAULT 1"))
    if "created_at" not in vehicle_columns:
        await conn.execute(text("ALTER TABLE vehicles ADD COLUMN created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP"))
    if "updated_at" not in vehicle_columns:
        await conn.execute(text("ALTER TABLE vehicles ADD COLUMN updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP"))

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
    if not _should_sync("logistics_so_schema"):
        return
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
    if not _should_sync("universal_dispatch_ack_schema"):
        return
    conn = await session.connection()
    
    from app.models.dispatch import (
        DispatchDeliveryAcknowledgement, 
        DispatchAcknowledgementItem, 
        DispatchAcknowledgementDocument,
        DispatchOrderItem
    )
    from app.models.dispatch_custody import DispatchCustodyTransfer
    await conn.run_sync(DispatchDeliveryAcknowledgement.__table__.create, checkfirst=True)
    await conn.run_sync(DispatchAcknowledgementItem.__table__.create, checkfirst=True)
    await conn.run_sync(DispatchAcknowledgementDocument.__table__.create, checkfirst=True)
    await conn.run_sync(DispatchOrderItem.__table__.create, checkfirst=True)
    await conn.run_sync(DispatchCustodyTransfer.__table__.create, checkfirst=True)

    custody_columns = {
        row[0]
        for row in (await conn.execute(text("""
            SELECT column_name
            FROM information_schema.columns
            WHERE table_schema = DATABASE()
              AND table_name = 'dispatch_custody_transfers'
        """))).all()
    }
    if "seal_intact" not in custody_columns:
        await conn.execute(text("ALTER TABLE dispatch_custody_transfers ADD COLUMN seal_intact TINYINT(1) NULL"))
    if "packaging_condition" not in custody_columns:
        await conn.execute(text("ALTER TABLE dispatch_custody_transfers ADD COLUMN packaging_condition VARCHAR(50) NULL"))
    if "discrepancy_reported" not in custody_columns:
        await conn.execute(text("ALTER TABLE dispatch_custody_transfers ADD COLUMN discrepancy_reported TINYINT(1) NULL"))
    if "remarks" not in custody_columns:
        await conn.execute(text("ALTER TABLE dispatch_custody_transfers ADD COLUMN remarks TEXT NULL"))

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
    if "dispatch_mode" not in columns:
        await conn.execute(text("ALTER TABLE dispatch_orders ADD COLUMN dispatch_mode VARCHAR(50) NOT NULL DEFAULT 'direct'"))
    
    try:
        await conn.execute(text("""
            ALTER TABLE dispatch_orders 
            MODIFY COLUMN status VARCHAR(50) DEFAULT 'draft'
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


async def ensure_search_indexes(session: AsyncSession) -> None:
    """Create MySQL FULLTEXT indexes for fast search on employees, positions, offices.

    Without these, every search uses a full-table ilike() scan (leading % disables
    B-tree). FULLTEXT indexes let us use MATCH ... AGAINST (IN BOOLEAN MODE) which
    is significantly faster on large datasets (5000+ rows).

    Safe to call repeatedly — each ALTER is wrapped in a try/except so it is
    skipped if the index already exists.
    """
    if not _should_sync("search_indexes"):
        return
    conn = await session.connection()

    for stmt in [
        # employees: search by name + employee_code
        """
        ALTER TABLE employees
        ADD FULLTEXT INDEX ft_emp_name_code (name, employee_code)
        """,
        # positions: search by name + code + role_name + department
        """
        ALTER TABLE positions
        ADD FULLTEXT INDEX ft_pos_name_code (name, code, role_name, department)
        """,
        # offices: search by name + state + district + cluster
        """
        ALTER TABLE offices
        ADD FULLTEXT INDEX ft_office_name (name, state, district, cluster)
        """,
    ]:
        try:
            await conn.execute(text(stmt))
        except Exception:
            pass  # Index already exists — safe to ignore



async def ensure_item_sub_classes_schema(session: AsyncSession) -> None:
    if not _should_sync("item_sub_classes_schema"):
        return
    conn = await session.connection()
    from app.models.inventory_master import ItemSubClass
    await conn.run_sync(ItemSubClass.__table__.create, checkfirst=True)

    items_cols = {
        row[0]
        for row in (await conn.execute(text("""
            SELECT column_name
            FROM information_schema.columns
            WHERE table_schema = DATABASE()
              AND table_name = 'items'
        """))).all()
    }
    if "item_sub_class_id" not in items_cols:
        try:
            await conn.execute(text("ALTER TABLE items ADD COLUMN item_sub_class_id BIGINT NULL"))
            await conn.execute(text("ALTER TABLE items ADD CONSTRAINT fk_items_item_sub_class_id FOREIGN KEY (item_sub_class_id) REFERENCES item_sub_classes (id) ON DELETE SET NULL"))
        except Exception as exc:
            print(f"Failed to add column item_sub_class_id to items: {exc}")

    for type_name in ("license", "service"):
        await conn.execute(
            text("""
                INSERT INTO item_types (name, is_active, created_at)
                SELECT :name, 1, CURRENT_TIMESTAMP
                WHERE NOT EXISTS (SELECT 1 FROM item_types WHERE name = :name)
            """),
            {"name": type_name}
        )

    result = await conn.execute(text("SELECT id, name FROM item_types"))
    type_map = {row[1].lower(): row[0] for row in result.all()}

    subclass_seeds = [
        {"class_name": "asset", "name": "Asset", "code": "AST", "desc": "Capital items having unique identity", "inv": "Yes", "dep": "Yes", "ex": "Ambulance, Laptop, ECG Machine"},
        {"class_name": "asset", "name": "Accessory", "code": "ACC", "desc": "Supports another asset; may be replaceable", "inv": "Yes", "dep": "Usually No", "ex": "ECG Lead Cable, Printer Tray, Probe Cover"},
        {"class_name": "asset", "name": "Tool", "code": "TOL", "desc": "Maintenance or operational tools", "inv": "Yes", "dep": "Sometimes", "ex": "Screwdriver, Torque Wrench, Multimeter"},
        {"class_name": "asset", "name": "Returnable Item", "code": "RET", "desc": "Issued and expected to be returned", "inv": "Yes", "dep": "No", "ex": "Oxygen Cylinder, Crate, Instrument Box"},
        
        {"class_name": "consumable", "name": "Consumable", "code": "CON", "desc": "Used up during operations", "inv": "Yes", "dep": "No", "ex": "Gloves, Syringes, Reagents"},
        
        {"class_name": "asset", "name": "Spare Part", "code": "SPL", "desc": "Replacement parts used during maintenance", "inv": "Yes", "dep": "No", "ex": "Brake Pad, Tyre, Battery, Engine Belt"},
        {"class_name": "consumable", "name": "Spare Part", "code": "SPL", "desc": "Replacement parts used during maintenance", "inv": "Yes", "dep": "No", "ex": "Brake Pad, Tyre, Battery, Engine Belt"},
        
        {"class_name": "asset", "name": "Kit / Assembly", "code": "KIT", "desc": "Collection of multiple materials issued together", "inv": "Yes", "dep": "Depends", "ex": "First Aid Kit, Sample Collection Kit"},
        {"class_name": "consumable", "name": "Kit / Assembly", "code": "KIT", "desc": "Collection of multiple materials issued together", "inv": "Yes", "dep": "Depends", "ex": "First Aid Kit, Sample Collection Kit"},
        
        {"class_name": "asset", "name": "Packing Material", "code": "PKG", "desc": "Packaging and transportation materials", "inv": "Yes", "dep": "No", "ex": "Cartons, Bubble Wrap, Ice Box"},
        {"class_name": "consumable", "name": "Packing Material", "code": "PKG", "desc": "Packaging and transportation materials", "inv": "Yes", "dep": "No", "ex": "Cartons, Bubble Wrap, Ice Box"},
        
        {"class_name": "asset", "name": "Stationery", "code": "STA", "desc": "Office supplies", "inv": "Yes", "dep": "No", "ex": "Pens, Registers, Printer Paper"},
        {"class_name": "consumable", "name": "Stationery", "code": "STA", "desc": "Office supplies", "inv": "Yes", "dep": "No", "ex": "Pens, Registers, Printer Paper"},
        
        {"class_name": "asset", "name": "Personal Protective Equipment", "code": "PPE", "desc": "Safety equipment issued to employees", "inv": "Yes", "dep": "Usually No", "ex": "Lab Coat, Helmet, Safety Shoes"},
        {"class_name": "consumable", "name": "Personal Protective Equipment", "code": "PPE", "desc": "Safety equipment issued to employees", "inv": "Yes", "dep": "Usually No", "ex": "Lab Coat, Helmet, Safety Shoes"},
        
        {"class_name": "license", "name": "Software / License", "code": "LIC", "desc": "Digital assets", "inv": "Optional", "dep": "Yes/Amortized", "ex": "Windows License, Antivirus"},
        
        {"class_name": "service", "name": "Service (Long-Term)", "code": "SER (Long-Term)", "desc": "Non-stock service item", "inv": "No", "dep": "No", "ex": "Calibration Service, AMC, Courier Charges"},
        {"class_name": "service", "name": "Service (Short-Term)", "code": "SER (Short-Term)", "desc": "Non-stock service item", "inv": "No", "dep": "No", "ex": "Hamali Charges, Transportation"}
    ]

    for seed in subclass_seeds:
        type_id = type_map.get(seed["class_name"])
        if not type_id:
            continue
        await conn.execute(
            text("""
                INSERT INTO item_sub_classes (item_type_id, name, code, description, inventory, depreciation, example, is_active, created_at)
                SELECT :type_id, :name, :code, :desc, :inv, :dep, :ex, 1, CURRENT_TIMESTAMP
                WHERE NOT EXISTS (
                    SELECT 1 FROM item_sub_classes 
                    WHERE item_type_id = :type_id AND code = :code
                )
            """),
            {
                "type_id": type_id,
                "name": seed["name"],
                "code": seed["code"],
                "desc": seed["desc"],
                "inv": seed["inv"],
                "dep": seed["dep"],
                "ex": seed["ex"]
            }
        )

