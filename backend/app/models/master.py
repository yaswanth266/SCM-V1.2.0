from sqlalchemy import Column, BigInteger, String, Text, Boolean, DateTime, Date, Enum, ForeignKey, Numeric, Integer, UniqueConstraint
from sqlalchemy.orm import relationship
from datetime import datetime, timezone
from app.database import Base


class UOMCategory(Base):
    __tablename__ = "uom_categories"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    name = Column(String(100), unique=True, nullable=False)
    description = Column(Text)
    base_uom_id = Column(BigInteger, ForeignKey("uom.id"), nullable=True)
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    updated_at = Column(DateTime, default=lambda: datetime.now(timezone.utc), onupdate=lambda: datetime.now(timezone.utc))

    uoms = relationship("UOM", back_populates="category", foreign_keys="UOM.category_id")
    base_uom = relationship("UOM", foreign_keys=[base_uom_id], post_update=True)


class UOM(Base):
    __tablename__ = "uom"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    category_id = Column(BigInteger, ForeignKey("uom_categories.id"), nullable=True)
    name = Column(String(50), nullable=False)
    abbreviation = Column(String(10), nullable=False)
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    updated_at = Column(DateTime, default=lambda: datetime.now(timezone.utc), onupdate=lambda: datetime.now(timezone.utc))

    category = relationship("UOMCategory", back_populates="uoms", foreign_keys=[category_id])


class UOMConversion(Base):
    __tablename__ = "uom_conversions"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    category_id = Column(BigInteger, ForeignKey("uom_categories.id"), nullable=True)
    from_uom_id = Column(BigInteger, ForeignKey("uom.id"), nullable=False)
    to_uom_id = Column(BigInteger, ForeignKey("uom.id"), nullable=False)
    factor_num = Column(Numeric(24, 12), nullable=False, default=1)
    factor_den = Column(Numeric(24, 12), nullable=False, default=1)
    conversion_factor = Column(Numeric(24, 12), nullable=False)
    valid_from = Column(DateTime, nullable=False, default=lambda: datetime.now(timezone.utc))
    valid_to = Column(DateTime, nullable=True)
    is_system = Column(Boolean, default=False)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    updated_at = Column(DateTime, default=lambda: datetime.now(timezone.utc), onupdate=lambda: datetime.now(timezone.utc))

    category = relationship("UOMCategory", foreign_keys=[category_id])
    from_uom = relationship("UOM", foreign_keys=[from_uom_id])
    to_uom = relationship("UOM", foreign_keys=[to_uom_id])


class ItemUOMConversion(Base):
    __tablename__ = "item_uom_conversions"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    item_id = Column(BigInteger, ForeignKey("items.id"), nullable=False)
    from_uom_id = Column(BigInteger, ForeignKey("uom.id"), nullable=False)
    to_uom_id = Column(BigInteger, ForeignKey("uom.id"), nullable=False)
    conversion_type = Column(String(50))
    factor_num = Column(Numeric(24, 12), nullable=False, default=1)
    factor_den = Column(Numeric(24, 12), nullable=False, default=1)
    conversion_factor = Column(Numeric(24, 12), nullable=False)
    valid_from = Column(DateTime, nullable=False, default=lambda: datetime.now(timezone.utc))
    valid_to = Column(DateTime, nullable=True)
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    updated_at = Column(DateTime, default=lambda: datetime.now(timezone.utc), onupdate=lambda: datetime.now(timezone.utc))

    item = relationship("Item", foreign_keys=[item_id])
    from_uom = relationship("UOM", foreign_keys=[from_uom_id])
    to_uom = relationship("UOM", foreign_keys=[to_uom_id])


class ItemCategory(Base):
    __tablename__ = "item_categories"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    parent_id = Column(BigInteger, ForeignKey("item_categories.id"))
    name = Column(String(255), nullable=False)
    code = Column(String(50), unique=True, nullable=False)
    code_prefix = Column(String(10))  # Wave 11 — used in BHSPL-PH-MED-T-0001 codes
    short_code = Column(String(2), nullable=True)
    full_code = Column(String(6), unique=True, nullable=True)
    description = Column(Text)
    level = Column(Integer, default=0)
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))

    parent = relationship("ItemCategory", remote_side=[id])
    items = relationship("Item", back_populates="category")
    features = relationship("Feature", back_populates="category")


class ItemType(Base):
    __tablename__ = "item_types"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    name = Column(String(100), unique=True, nullable=False)
    description = Column(Text)
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))


class Feature(Base):
    __tablename__ = "features"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    category_id = Column(BigInteger, ForeignKey("item_categories.id"), nullable=False)
    name = Column(String(255), nullable=False)
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))

    category = relationship("ItemCategory", back_populates="features")


class Item(Base):
    __tablename__ = "items"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    category_id = Column(BigInteger, ForeignKey("item_categories.id"))
    item_code = Column(String(50), unique=True, nullable=False)
    name = Column(String(255), nullable=False, unique=True)
    description = Column(Text)
    item_type = Column(String(100), ForeignKey("item_types.name"), nullable=False)
    uom_category_id = Column(BigInteger, ForeignKey("uom_categories.id"), nullable=True)
    primary_uom_id = Column(BigInteger, ForeignKey("uom.id"), nullable=False)
    secondary_uom_id = Column(BigInteger, ForeignKey("uom.id"))
    hsn_code = Column(String(20))
    sku = Column(String(100))
    barcode_type = Column(Enum("qrcode", "barcode_128", "barcode_ean13", "auto", name="barcode_type_enum"), default="auto")
    barcode_value = Column(String(255))
    has_batch = Column(Boolean, default=False)
    has_serial = Column(Boolean, default=False)
    has_expiry = Column(Boolean, default=False)
    shelf_life_days = Column(Integer, default=0)
    safety_stock = Column(Numeric(15, 3), default=0)
    reorder_level = Column(Numeric(15, 3), default=0)
    reorder_qty = Column(Numeric(15, 3), default=0)
    lead_time_days = Column(Integer, default=0)
    min_order_qty = Column(Numeric(15, 3), default=0)
    max_order_qty = Column(Numeric(15, 3), default=0)
    tax_rate = Column(Numeric(5, 2), default=0)
    cgst_rate = Column(Numeric(5, 2), default=0)
    sgst_rate = Column(Numeric(5, 2), default=0)
    igst_rate = Column(Numeric(5, 2), default=0)
    purchase_price = Column(Numeric(15, 2), default=0)
    selling_price = Column(Numeric(15, 2), default=0)
    mrp = Column(Numeric(15, 2), default=0)
    image_url = Column(String(500))
    brand = Column(String(255) , ForeignKey("brands.code"), nullable=True)
    manufacturer = Column(String(255))
    marketer = Column(String(255))
    distributor = Column(String(255))

    feature_id = Column(BigInteger, ForeignKey("features.id"), nullable=True)
    ownership = Column(Enum("IT", "HR", "OP", "ADM", "FA", "FL", name="item_ownership"), nullable=True)
    dosage_form = Column(String(100))
    valuation_method = Column(Enum("fifo", "fefo", "lifo", "weighted_average", name="valuation_method_enum"), default="fifo")
    # Wave 11 — coding scheme support
    dosage_form_code = Column(String(2))  # T/S/I/C/O — used in code generation
    coding_status = Column(Enum("auto", "manual", "legacy", name="item_coding_status_enum"), default="legacy")
    # Wave 7 — Healthcare compliance flags
    drug_schedule = Column(Enum("X", "H", "H1", "G", "OTC", "none", name="drug_schedule_enum"), default="none")
    is_schedule_h1 = Column(Boolean, default=False)
    is_narcotic = Column(Boolean, default=False)
    requires_prescription = Column(Boolean, default=False)
    requires_cold_chain = Column(Boolean, default=False)
    min_storage_temp_c = Column(Numeric(5, 2))
    max_storage_temp_c = Column(Numeric(5, 2))
    regulatory_notes = Column(Text)
    is_active = Column(Boolean, default=True)
    created_by = Column(BigInteger)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    updated_at = Column(DateTime, default=lambda: datetime.now(timezone.utc), onupdate=lambda: datetime.now(timezone.utc))

    category = relationship("ItemCategory", back_populates="items")
    uom_category = relationship("UOMCategory", foreign_keys=[uom_category_id])
    primary_uom = relationship("UOM", foreign_keys=[primary_uom_id])
    secondary_uom = relationship("UOM", foreign_keys=[secondary_uom_id])
    feature_links = relationship("ItemFeature", back_populates="item", cascade="all, delete-orphan")
    brand_obj = relationship("Brand", foreign_keys=[brand])
    item_type_obj = relationship("ItemType", foreign_keys=[item_type])
    feature = relationship("Feature", foreign_keys=[feature_id])
    packagings = relationship("ItemPackaging", back_populates="item", cascade="all, delete-orphan")

class PackagingLevel(Base):
    __tablename__ = 'packaging_level'

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    level_name = Column(String(100), nullable=False)
    level_order = Column(Integer, nullable=False, unique=True)


class ItemPackaging(Base):
    __tablename__ = 'item_packaging'

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    item_id = Column(BigInteger, ForeignKey('items.id', ondelete="CASCADE"), nullable=False)
    level_id = Column(BigInteger, ForeignKey('packaging_level.id'), nullable=False)
    parent_id = Column(BigInteger, ForeignKey('item_packaging.id', ondelete="CASCADE"), nullable=True)
    qty_per_parent = Column(Integer, nullable=False)
    total_base_qty = Column(Integer, nullable=False, default=1)
    sku_code = Column(String(100), nullable=True)
    sku_name = Column(String(500), nullable=False)

    item = relationship("Item", back_populates="packagings")
    level = relationship("PackagingLevel")
    parent = relationship("ItemPackaging", remote_side=[id], backref="children")


class PriceList(Base):
    __tablename__ = "price_lists"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    name = Column(String(255), nullable=False)
    type = Column(Enum("buying", "selling", name="price_list_type_enum"), nullable=False)
    currency = Column(String(3), default="INR")
    is_default = Column(Boolean, default=False)
    valid_from = Column(DateTime)
    valid_to = Column(DateTime)
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))

    items = relationship("PriceListItem", back_populates="price_list")


class PriceListItem(Base):
    __tablename__ = "price_list_items"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    price_list_id = Column(BigInteger, ForeignKey("price_lists.id"), nullable=False)
    item_id = Column(BigInteger, ForeignKey("items.id"), nullable=False)
    rate = Column(Numeric(15, 2), nullable=False)
    min_qty = Column(Numeric(15, 3), default=0)
    valid_from = Column(DateTime)
    valid_to = Column(DateTime)

    price_list = relationship("PriceList", back_populates="items")
    item = relationship("Item")


class Vendor(Base):
    __tablename__ = "vendors"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    vendor_code = Column(String(50), unique=True, nullable=False)
    name = Column(String(255), nullable=False)
    contact_person = Column(String(255))
    email = Column(String(255))
    phone = Column(String(20))
    alt_phone = Column(String(20))
    address_line1 = Column(String(255))
    address_line2 = Column(String(255))
    city = Column(String(100))
    state = Column(String(100))
    pincode = Column(String(10))
    country = Column(String(100), default="India")
    gst_number = Column(String(20))
    pan_number = Column(String(20))
    bank_name = Column(String(255))
    bank_account = Column(String(50))
    bank_ifsc = Column(String(20))
    payment_terms_days = Column(Integer, default=30)
    credit_limit = Column(Numeric(15, 2), default=0)
    vendor_type = Column(Enum("material", "transport", "service", "both", name="vendor_type_enum"), default="material")
    vendor_type_id = Column(BigInteger, ForeignKey("vendor_types.id"), nullable=True)
    vendor_category_id = Column(BigInteger, ForeignKey("vendor_categories.id"), nullable=True)
    rating = Column(Numeric(3, 2), default=0)
    is_transport_vendor = Column(Boolean, default=False)
    # Wave 7 — Healthcare compliance fields
    drug_license_number = Column(String(50))
    drug_license_state = Column(String(100))
    drug_license_expiry = Column(Date)
    gst_certificate_url = Column(String(500))
    license_doc_url = Column(String(500))
    vendor_compliance_status = Column(
        Enum("compliant", "expiring_soon", "expired", "not_required", name="vendor_compliance_status_enum"),
        default="not_required",
    )
    is_active = Column(Boolean, default=True)
    onboarded_date = Column(DateTime)
    created_by = Column(BigInteger)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    updated_at = Column(DateTime, default=lambda: datetime.now(timezone.utc), onupdate=lambda: datetime.now(timezone.utc))

    items = relationship("VendorItem", back_populates="vendor")
    type_links = relationship("VendorVendorType", back_populates="vendor", cascade="all, delete-orphan")
    primary_vendor_type = relationship("VendorType", foreign_keys=[vendor_type_id])
    category = relationship("VendorCategory", foreign_keys=[vendor_category_id])
    contracts = relationship("VendorContract", back_populates="vendor")
    ratings = relationship("VendorRating", back_populates="vendor")


class VendorType(Base):
    __tablename__ = "vendor_types"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    code = Column(String(50), unique=True, nullable=False)
    name = Column(String(100), nullable=False)
    description = Column(Text)
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    updated_at = Column(DateTime, default=lambda: datetime.now(timezone.utc), onupdate=lambda: datetime.now(timezone.utc))


class VendorCategory(Base):
    __tablename__ = "vendor_categories"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    code = Column(String(50), unique=True, nullable=False)
    name = Column(String(100), nullable=False)
    description = Column(Text)
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    updated_at = Column(DateTime, default=lambda: datetime.now(timezone.utc), onupdate=lambda: datetime.now(timezone.utc))


class VendorVendorType(Base):
    __tablename__ = "vendor_vendor_types"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    vendor_id = Column(BigInteger, ForeignKey("vendors.id", ondelete="CASCADE"), nullable=False)
    vendor_type_id = Column(BigInteger, ForeignKey("vendor_types.id"), nullable=False)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))

    vendor = relationship("Vendor", back_populates="type_links")
    vendor_type = relationship("VendorType")

    __table_args__ = (
        UniqueConstraint("vendor_id", "vendor_type_id", name="uq_vendor_vendor_type"),
    )


class VendorItem(Base):
    __tablename__ = "vendor_items"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    vendor_id = Column(BigInteger, ForeignKey("vendors.id"), nullable=False)
    item_id = Column(BigInteger, ForeignKey("items.id"), nullable=False)
    vendor_item_code = Column(String(100))
    lead_time_days = Column(Integer, default=0)
    min_order_qty = Column(Numeric(15, 3), default=0)
    rate = Column(Numeric(15, 2), default=0)
    is_preferred = Column(Boolean, default=False)

    vendor = relationship("Vendor", back_populates="items")
    item = relationship("Item")

    __table_args__ = (
        UniqueConstraint("vendor_id", "item_id", name="uq_vendor_item"),
    )


class VendorItemHistory(Base):
    __tablename__ = "vendor_item_history"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    vendor_item_id = Column(BigInteger, nullable=True)
    vendor_id = Column(BigInteger, ForeignKey("vendors.id"), nullable=False)
    item_id = Column(BigInteger, ForeignKey("items.id"), nullable=False)
    action = Column(String(20), nullable=False)
    old_vendor_item_code = Column(String(100))
    new_vendor_item_code = Column(String(100))
    old_lead_time_days = Column(Integer)
    new_lead_time_days = Column(Integer)
    old_min_order_qty = Column(Numeric(15, 3))
    new_min_order_qty = Column(Numeric(15, 3))
    old_rate = Column(Numeric(15, 2))
    new_rate = Column(Numeric(15, 2))
    old_is_preferred = Column(Boolean)
    new_is_preferred = Column(Boolean)
    changed_by_id = Column(BigInteger, ForeignKey("users.id"), nullable=True)
    changed_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))

    vendor = relationship("Vendor")
    item = relationship("Item")


class VendorContract(Base):
    __tablename__ = "vendor_contracts"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    vendor_id = Column(BigInteger, ForeignKey("vendors.id"), nullable=False)
    contract_number = Column(String(100), unique=True, nullable=False)
    title = Column(String(255))
    start_date = Column(DateTime, nullable=False)
    end_date = Column(DateTime, nullable=False)
    terms = Column(Text)
    document_url = Column(String(500))
    status = Column(Enum("draft", "active", "expired", "terminated", name="contract_status_enum"), default="draft")
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))

    vendor = relationship("Vendor", back_populates="contracts")


class VendorRating(Base):
    __tablename__ = "vendor_ratings"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    vendor_id = Column(BigInteger, ForeignKey("vendors.id"), nullable=False)
    period_from = Column(DateTime)
    period_to = Column(DateTime)
    delivery_timeliness = Column(Numeric(3, 2), default=0)
    cost_efficiency = Column(Numeric(3, 2), default=0)
    service_reliability = Column(Numeric(3, 2), default=0)
    delivery_accuracy = Column(Numeric(3, 2), default=0)
    overall_rating = Column(Numeric(3, 2), default=0)
    remarks = Column(Text)
    rated_by = Column(BigInteger)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))

    vendor = relationship("Vendor", back_populates="ratings")


class Customer(Base):
    __tablename__ = "customers"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    customer_code = Column(String(50), unique=True, nullable=False)
    name = Column(String(255), nullable=False)
    contact_person = Column(String(255))
    email = Column(String(255))
    phone = Column(String(20))
    address_line1 = Column(String(255))
    address_line2 = Column(String(255))
    city = Column(String(100))
    state = Column(String(100))
    pincode = Column(String(10))
    country = Column(String(100), default="India")
    gst_number = Column(String(20))
    credit_limit = Column(Numeric(15, 2), default=0)
    payment_terms_days = Column(Integer, default=30)
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    updated_at = Column(DateTime, default=lambda: datetime.now(timezone.utc), onupdate=lambda: datetime.now(timezone.utc))


# =============================================================
# Phase-1 masters (2026-04-24): brands, item attributes, user groups.
# These support the mapping picture: category-scoped attributes, a
# normalized brand list, and user-group → entity permissions.
# =============================================================

class Brand(Base):
    __tablename__ = "brands"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    code = Column(String(50), unique=True, nullable=False)
    name = Column(String(255), nullable=False)
    manufacturer_id = Column(BigInteger, nullable=True)
    description = Column(Text)
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))


class ItemAttribute(Base):
    __tablename__ = "item_attributes"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    category_id = Column(BigInteger, ForeignKey("item_categories.id"), nullable=True)
    code = Column(String(50), nullable=False)
    name = Column(String(255), nullable=False)
    data_type = Column(
        Enum("text", "number", "boolean", "enum", name="attribute_data_type"),
        default="text", nullable=False,
    )
    uom_category_id = Column(BigInteger, ForeignKey("uom_categories.id"), nullable=True)
    uom_id = Column(BigInteger, ForeignKey("uom.id"), nullable=True)
    allowed_values = Column(Text)  # csv/json for data_type='enum'
    is_required = Column(Boolean, default=False)
    sort_order = Column(Integer, default=0)
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))

    category = relationship("ItemCategory")
    uom_category = relationship("UOMCategory")
    uom = relationship("UOM")


class ItemAttributeValue(Base):
    __tablename__ = "item_attribute_values"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    item_id = Column(BigInteger, ForeignKey("items.id", ondelete="CASCADE"), nullable=False)
    attribute_id = Column(BigInteger, ForeignKey("item_attributes.id", ondelete="CASCADE"), nullable=False)
    value = Column(String(500))
    uom_category_id = Column(BigInteger, ForeignKey("uom_categories.id"), nullable=True)
    uom_id = Column(BigInteger, ForeignKey("uom.id"), nullable=True)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))

    attribute = relationship("ItemAttribute")
    uom_category = relationship("UOMCategory")
    uom = relationship("UOM")


class SpecCategory(Base):
    __tablename__ = "spec_categories"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    code = Column(String(30), unique=True, nullable=False)
    name = Column(String(100), nullable=False)
    description = Column(Text, nullable=True)
    base_uom_id = Column(BigInteger, ForeignKey("uom.id"), nullable=True)
    sort_order = Column(Integer, default=0)
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))

    specs = relationship("Spec", back_populates="category")
    base_uom = relationship("UOM", foreign_keys=[base_uom_id])


class Spec(Base):
    __tablename__ = "specs"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    category_id = Column(BigInteger, ForeignKey("spec_categories.id"), nullable=False)
    code = Column(String(50), unique=True, nullable=False)
    name = Column(String(100), nullable=False)
    data_type = Column(Enum("text", "number", "boolean", "enum", "range", name="spec_data_type"), nullable=False)
    uom_id = Column(BigInteger, ForeignKey("uom.id"), nullable=True)
    uom_category_id = Column(BigInteger, ForeignKey("uom_categories.id"), nullable=True)
    allowed_values = Column(Text, nullable=True)
    is_required = Column(Boolean, default=False)
    sort_order = Column(Integer, default=0)
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))

    category = relationship("SpecCategory", back_populates="specs")
    default_uom = relationship("UOM", foreign_keys=[uom_id])
    uom_category = relationship("UOMCategory", foreign_keys=[uom_category_id])


class ItemSpec(Base):
    __tablename__ = "item_specs"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    item_category_id = Column(BigInteger, ForeignKey("item_categories.id"), nullable=False)
    spec_id = Column(BigInteger, ForeignKey("specs.id"), nullable=False)
    default_value = Column(String(500), nullable=True)
    uom_id = Column(BigInteger, ForeignKey("uom.id"), nullable=True)
    is_required = Column(Boolean, default=False)
    sort_order = Column(Integer, default=0)
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))

    item_category = relationship("ItemCategory", foreign_keys=[item_category_id])
    spec = relationship("Spec")
    default_uom = relationship("UOM", foreign_keys=[uom_id])

    __table_args__ = (
        UniqueConstraint("item_category_id", "spec_id", name="uq_item_category_spec"),
    )


class ItemSpecValue(Base):
    __tablename__ = "item_spec_values"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    item_id = Column(BigInteger, ForeignKey("items.id"), nullable=False)
    spec_id = Column(BigInteger, ForeignKey("specs.id"), nullable=False)
    value = Column(String(500), nullable=True)
    min_value = Column(String(100), nullable=True)
    max_value = Column(String(100), nullable=True)
    uom_id = Column(BigInteger, ForeignKey("uom.id"), nullable=True)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))

    item = relationship("Item", foreign_keys=[item_id])
    spec = relationship("Spec")
    uom = relationship("UOM")

    __table_args__ = (
        UniqueConstraint("item_id", "spec_id", name="uq_item_spec"),
    )


class ItemFeature(Base):
    __tablename__ = "item_features"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    item_id = Column(BigInteger, ForeignKey("items.id", ondelete="CASCADE"), nullable=False)
    feature_id = Column(BigInteger, ForeignKey("features.id", ondelete="CASCADE"), nullable=False)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))

    item = relationship("Item", back_populates="feature_links")
    feature = relationship("Feature")


class UserGroup(Base):
    __tablename__ = "user_groups"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    code = Column(String(50), unique=True, nullable=False)
    name = Column(String(255), nullable=False)
    description = Column(Text)
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))


class UserGroupMember(Base):
    __tablename__ = "user_group_members"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    group_id = Column(BigInteger, ForeignKey("user_groups.id", ondelete="CASCADE"), nullable=False)
    user_id = Column(BigInteger, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    added_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))


class UserGroupPermission(Base):
    __tablename__ = "user_group_permissions"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    group_id = Column(BigInteger, ForeignKey("user_groups.id", ondelete="CASCADE"), nullable=False)
    entity_type = Column(String(50), nullable=False)  # 'item_category','item','uom','indent_type','warehouse'
    entity_id = Column(BigInteger, nullable=True)  # null = applies to all of that entity_type
    action = Column(String(50), default="view")  # 'view','create','approve','indent','consume'
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))


class UserItemPermission(Base):
    __tablename__ = "user_item_permissions"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    user_id = Column(BigInteger, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    entity_type = Column(String(50), nullable=False)
    entity_id = Column(BigInteger, nullable=True)
    action = Column(String(50), default="view", nullable=False)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))


class RoleItemPermission(Base):
    __tablename__ = "role_item_permissions"
    __table_args__ = (
        UniqueConstraint("role_id", "entity_type", "entity_id", "action", name="uq_role_item_permissions_scope"),
    )

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    role_id = Column(BigInteger, ForeignKey("roles.id", ondelete="CASCADE"), nullable=False)
    entity_type = Column(String(50), nullable=False)
    entity_id = Column(BigInteger, nullable=True)
    action = Column(String(50), default="view", nullable=False)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))

    role = relationship("Role")



class Office(Base):
    __tablename__ = "offices"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    name = Column(String(255), nullable=False)
    level = Column(String(50))
    country = Column(String(100))
    state = Column(String(100))
    district = Column(String(100))
    mandal = Column(String(100))
    cluster = Column(String(100))
    cluster_type = Column(String(50))
    specific_location = Column(String(255))
    address = Column(Text)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    updated_at = Column(DateTime, default=lambda: datetime.now(timezone.utc), onupdate=lambda: datetime.now(timezone.utc))

    positions = relationship("Position", back_populates="office")


class Position(Base):
    __tablename__ = "positions"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    name = Column(String(255), nullable=False)
    code = Column(String(100), unique=True, nullable=False)
    role_name = Column(String(100))
    role_id = Column(BigInteger, ForeignKey("roles.id", ondelete="SET NULL"), nullable=True)
    level_name = Column(String(50))
    level_rank = Column(Integer)
    department = Column(String(100))
    section = Column(String(100))
    project_id = Column(BigInteger, ForeignKey("projects.id", ondelete="SET NULL"), nullable=True)
    office_id = Column(BigInteger, ForeignKey("offices.id", ondelete="SET NULL"), nullable=True)
    parent_position_id = Column(BigInteger, ForeignKey("positions.id", ondelete="SET NULL"), nullable=True)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    updated_at = Column(DateTime, default=lambda: datetime.now(timezone.utc), onupdate=lambda: datetime.now(timezone.utc))

    project = relationship("Project")
    role = relationship("Role")
    office = relationship("Office", back_populates="positions")
    parent_position = relationship("Position", remote_side=[id])
    employees = relationship("Employee", back_populates="position")


class Employee(Base):
    __tablename__ = "employees"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    employee_code = Column(String(50), unique=True, nullable=False)
    name = Column(String(255), nullable=False)
    photo = Column(String(255))
    status = Column(String(20), default="Active")
    dob = Column(Date)
    gender = Column(String(20))
    pan_number = Column(String(10), unique=True)
    aadhaar_number = Column(String(12), unique=True)
    email = Column(String(100), unique=True)
    phone = Column(String(15))
    position_id = Column(BigInteger, ForeignKey("positions.id", ondelete="SET NULL"), nullable=True)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    updated_at = Column(DateTime, default=lambda: datetime.now(timezone.utc), onupdate=lambda: datetime.now(timezone.utc))

    position = relationship("Position", back_populates="employees")
