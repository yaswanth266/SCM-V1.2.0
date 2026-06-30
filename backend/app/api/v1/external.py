from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, or_
import json
from typing import Optional

from app.database import get_db
from app.models.user import User
from app.utils.dependencies import require_api_key_scope, require_stock_balance_scope, require_items_scope

router = APIRouter()

@router.get("/masters/items")
async def get_items(
    limit: int = 100,
    offset: int = 0,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_items_scope()),
):
    """Get all items (Master Data). Requires 'masters:items:read' or granular scope."""
    from app.models.master import Item, RoleItemPermission
    from app.models.user import UserRole
    
    scopes = []
    if getattr(user, "used_api_key", None) and user.used_api_key.scopes:
        try:
            scopes = json.loads(user.used_api_key.scopes)
        except Exception:
            scopes = []

    stmt = select(Item)
    
    # Granular Scopes Filtering (based on Item Types)
    # Only filter if "masters:items:read" is NOT in scopes
    if "masters:items:read" not in scopes:
        allowed_types = []
        for s in scopes:
            if s.startswith("masters:items:") and s.endswith(":read"):
                item_type = s[len("masters:items:"):-len(":read")]
                allowed_types.append(item_type)
        if allowed_types:
            stmt = stmt.filter(Item.item_type.in_(allowed_types))
        else:
            # If they have no matching granular scopes, return empty results
            stmt = stmt.filter(False)

    linked_ids = getattr(user, "used_api_key", None) and user.used_api_key.linked_user_ids
    if linked_ids:
        if isinstance(linked_ids, str):
            try:
                import json as _json
                linked_ids = _json.loads(linked_ids)
            except Exception:
                linked_ids = []
        if linked_ids:
            stmt = stmt.join(
                UserRole,
                UserRole.user_id.in_(linked_ids)
            ).join(
                RoleItemPermission,
                (RoleItemPermission.role_id == UserRole.role_id) &
                (
                    ((RoleItemPermission.entity_type == "item") & (RoleItemPermission.entity_id == Item.id)) |
                    ((RoleItemPermission.entity_type == "item_category") & (RoleItemPermission.entity_id == Item.category_id))
                )
            )
    
    result = await db.execute(stmt.limit(limit).offset(offset))
    items = result.scalars().unique().all()
    
    return [
        {
            "id": item.id,
            "item_code": item.item_code,
            "name": item.name,
            "description": item.description,
            "item_type": item.item_type,
            "is_active": item.is_active,
        }
        for item in items
    ]

@router.get("/masters/vendors")
async def get_vendors(
    limit: int = 100,
    offset: int = 0,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_api_key_scope("masters:vendors:read")),
):
    """Get all vendors (Master Data). Requires 'masters:read' scope."""
    from app.models.master import Vendor
    
    result = await db.execute(select(Vendor).limit(limit).offset(offset))
    vendors = result.scalars().all()
    
    return [
        {
            "id": vendor.id,
            "vendor_code": vendor.vendor_code,
            "name": vendor.name,
            "email": vendor.email,
            "phone": vendor.phone,
            "vendor_type": vendor.vendor_type,
            "is_active": vendor.is_active,
        }
        for vendor in vendors
    ]

@router.get("/inventory/stock")
async def get_stock(
    limit: int = 100,
    offset: int = 0,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_stock_balance_scope()),
):
    """Get stock balances (Inventory Data). Supports general or segregated scopes."""
    from app.models.stock import StockBalance
    from app.models.master import Item, RoleItemPermission
    from app.models.user import UserRole
    
    stmt = select(StockBalance)
    
    # Determine scope filtering
    scopes = []
    if getattr(user, "used_api_key", None) and user.used_api_key.scopes:
        try:
            scopes = json.loads(user.used_api_key.scopes)
        except Exception:
            scopes = []
            
    is_item_joined = False
    
    # 1. User Warehouse/Role Item Filtering (if linked_user_ids is present)
    linked_ids = getattr(user, "used_api_key", None) and user.used_api_key.linked_user_ids
    if linked_ids:
        if isinstance(linked_ids, str):
            try:
                import json as _json
                linked_ids = _json.loads(linked_ids)
            except Exception:
                linked_ids = []
        if linked_ids:
            stmt = stmt.join(Item, Item.id == StockBalance.item_id).join(
                UserRole,
                UserRole.user_id.in_(linked_ids)
            ).join(
                RoleItemPermission,
                (RoleItemPermission.role_id == UserRole.role_id) &
                (
                    ((RoleItemPermission.entity_type == "item") & (RoleItemPermission.entity_id == Item.id)) |
                    ((RoleItemPermission.entity_type == "item_category") & (RoleItemPermission.entity_id == Item.category_id))
                )
            )
            is_item_joined = True

    # 2. Granular Scopes Filtering (based on Item Types only)
    # Only filter if "inventory:stock-balance:read" is NOT in scopes
    if "inventory:stock-balance:read" not in scopes:
        allowed_types = []
        for s in scopes:
            if s.startswith("inventory:stock-balance:") and s.endswith(":read"):
                item_type = s[len("inventory:stock-balance:"):-len(":read")]
                allowed_types.append(item_type)
        
        if allowed_types:
            if not is_item_joined:
                stmt = stmt.join(Item, Item.id == StockBalance.item_id)
                is_item_joined = True
            stmt = stmt.filter(Item.item_type.in_(allowed_types))
        else:
            # If they have no matching granular scopes, return empty results
            if not is_item_joined:
                stmt = stmt.join(Item, Item.id == StockBalance.item_id)
            stmt = stmt.filter(False)
            
    result = await db.execute(stmt.limit(limit).offset(offset))
    stock_balances = result.scalars().unique().all()
    
    return [
        {
            "id": stock.id,
            "item_id": stock.item_id,
            "warehouse_id": stock.warehouse_id,
            "total_qty": stock.total_qty,
            "available_qty": stock.available_qty,
        }
        for stock in stock_balances
    ]

@router.get("/indent/acknowledgements")
async def get_indent_acknowledgements(
    indent_id: Optional[int] = None,
    limit: int = 100,
    offset: int = 0,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_api_key_scope("indent:acknowledgement:read")),
):
    """Get all indent acknowledgements. Requires 'indent:acknowledgement:read' scope."""
    from app.models.indent import IndentAcknowledgement, IndentAcknowledgementItem, IndentItem
    from sqlalchemy.orm import selectinload
    
    stmt = (
        select(IndentAcknowledgement)
        .options(
            selectinload(IndentAcknowledgement.acknowledger),
            selectinload(IndentAcknowledgement.items).selectinload(IndentAcknowledgementItem.item),
            selectinload(IndentAcknowledgement.items).selectinload(IndentAcknowledgementItem.indent_item).selectinload(IndentItem.uom),
        )
    )
    
    if indent_id is not None:
        stmt = stmt.where(IndentAcknowledgement.indent_id == indent_id)
        
    result = await db.execute(stmt.limit(limit).offset(offset))
    acks = result.scalars().all()
    
    return [
        {
            "id": ack.id,
            "indent_id": ack.indent_id,
            "warehouse_id": ack.warehouse_id,
            "acknowledged_by": ack.acknowledged_by,
            "empcode": ack.employee_code or (ack.acknowledger.employee_code if ack.acknowledger else None),
            "employee_code": ack.employee_code or (ack.acknowledger.employee_code if ack.acknowledger else None),
            "acknowledged_at": ack.acknowledged_at.isoformat() if ack.acknowledged_at else None,
            "received_qty": float(ack.received_qty) if ack.received_qty is not None else 0.0,
            "status": ack.status,
            "remarks": ack.remarks,
            "items": [
                {
                    "id": ai.id,
                    "item_id": ai.item_id,
                    "indent_item_id": ai.indent_item_id,
                    "item_code": ai.item.item_code if ai.item else None,
                    "item_name": ai.item.name if ai.item else None,
                    "uom": (
                        ai.indent_item.uom.name
                        if ai.indent_item and ai.indent_item.uom
                        else None
                    ),
                    "approved_qty": float(ai.indent_item.approved_qty) if ai.indent_item and ai.indent_item.approved_qty is not None else None,
                    "requested_qty": float(ai.indent_item.requested_qty) if ai.indent_item and ai.indent_item.requested_qty is not None else None,
                    "received_qty": float(ai.received_qty) if ai.received_qty is not None else 0.0,
                    "remarks": ai.remarks,
                }
                for ai in (ack.items or [])
            ]
        }
        for ack in acks
    ]


@router.get("/masters/warehouses")
async def get_warehouses(
    limit: int = 100,
    offset: int = 0,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_api_key_scope("masters:warehouses:read")),
):
    """Get all warehouses. Requires 'masters:warehouses:read' scope."""
    from app.models.warehouse import Warehouse
    result = await db.execute(select(Warehouse).where(Warehouse.is_active == True).limit(limit).offset(offset))
    rows = result.scalars().all()
    return [
        {"id": w.id, "code": w.code, "name": w.name, "type": w.type, "is_active": w.is_active}
        for w in rows
    ]


@router.get("/masters/packaging")
async def get_packaging(
    limit: int = 100,
    offset: int = 0,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_api_key_scope("masters:packaging:read")),
):
    """Get all packaging types. Requires 'masters:packaging:read' scope."""
    from app.models.master import PackagingType
    result = await db.execute(select(PackagingType).limit(limit).offset(offset))
    rows = result.scalars().all()
    return [
        {"id": r.id, "name": r.name, "code": getattr(r, 'code', None), "is_active": getattr(r, 'is_active', True)}
        for r in rows
    ]


@router.get("/masters/categories")
async def get_categories(
    limit: int = 100,
    offset: int = 0,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_api_key_scope("masters:categories:read")),
):
    """Get all item categories. Requires 'masters:categories:read' scope."""
    from app.models.master import ItemCategory
    result = await db.execute(select(ItemCategory).limit(limit).offset(offset))
    rows = result.scalars().all()
    return [
        {"id": r.id, "name": r.name, "code": getattr(r, 'code', None), "is_active": getattr(r, 'is_active', True)}
        for r in rows
    ]


@router.get("/masters/uom")
async def get_uom(
    limit: int = 100,
    offset: int = 0,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_api_key_scope("masters:uom:read")),
):
    """Get all units of measure. Requires 'masters:uom:read' scope."""
    from app.models.master import UnitOfMeasure
    result = await db.execute(select(UnitOfMeasure).limit(limit).offset(offset))
    rows = result.scalars().all()
    return [
        {"id": r.id, "name": r.name, "symbol": getattr(r, 'symbol', None), "is_active": getattr(r, 'is_active', True)}
        for r in rows
    ]


@router.get("/masters/brands")
async def get_brands(
    limit: int = 100,
    offset: int = 0,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_api_key_scope("masters:brands:read")),
):
    """Get all brands. Requires 'masters:brands:read' scope."""
    from app.models.master import Brand
    result = await db.execute(select(Brand).limit(limit).offset(offset))
    rows = result.scalars().all()
    return [
        {"id": r.id, "name": r.name, "code": getattr(r, 'code', None), "is_active": getattr(r, 'is_active', True)}
        for r in rows
    ]


@router.get("/masters/features")
async def get_features(
    limit: int = 100,
    offset: int = 0,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_api_key_scope("masters:features:read")),
):
    """Get all features. Requires 'masters:features:read' scope."""
    from app.models.master import Feature
    result = await db.execute(select(Feature).limit(limit).offset(offset))
    rows = result.scalars().all()
    return [
        {"id": r.id, "name": r.name, "is_active": getattr(r, 'is_active', True)}
        for r in rows
    ]


@router.get("/masters/item-types")
async def get_item_types(
    limit: int = 100,
    offset: int = 0,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_api_key_scope("masters:item-types:read")),
):
    """Get all item types. Requires 'masters:item-types:read' scope."""
    from app.models.master import ItemType
    result = await db.execute(select(ItemType).limit(limit).offset(offset))
    rows = result.scalars().all()
    return [
        {"id": r.id, "name": r.name, "is_active": getattr(r, 'is_active', True)}
        for r in rows
    ]


@router.get("/masters/attributes")
async def get_attributes(
    limit: int = 100,
    offset: int = 0,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_api_key_scope("masters:attributes:read")),
):
    """Get all item attributes. Requires 'masters:attributes:read' scope."""
    from app.models.master import ItemAttribute
    result = await db.execute(select(ItemAttribute).limit(limit).offset(offset))
    rows = result.scalars().all()
    return [
        {"id": r.id, "name": r.name, "is_active": getattr(r, 'is_active', True)}
        for r in rows
    ]


@router.get("/masters/users")
async def get_users_external(
    limit: int = 100,
    offset: int = 0,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_api_key_scope("masters:users:read")),
):
    """Get all users. Requires 'masters:users:read' scope."""
    from app.models.user import User as _User
    result = await db.execute(
        select(_User.id, _User.username, _User.email, _User.is_active, _User.employee_id)
        .limit(limit).offset(offset)
    )
    rows = result.all()
    return [
        {"id": r.id, "username": r.username, "email": r.email, "is_active": r.is_active, "employee_id": r.employee_id}
        for r in rows
    ]


@router.get("/inventory/stock-ledger")
async def get_stock_ledger(
    limit: int = 100,
    offset: int = 0,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_api_key_scope("inventory:stock-ledger:read")),
):
    """Get stock ledger entries. Requires 'inventory:stock-ledger:read' scope."""
    from app.models.stock import StockLedger
    result = await db.execute(select(StockLedger).order_by(StockLedger.id.desc()).limit(limit).offset(offset))
    rows = result.scalars().all()
    return [
        {
            "id": r.id,
            "item_id": r.item_id,
            "warehouse_id": r.warehouse_id,
            "transaction_type": r.transaction_type,
            "qty_in": float(r.qty_in or 0),
            "qty_out": float(r.qty_out or 0),
            "created_at": r.created_at.isoformat() if r.created_at else None,
        }
        for r in rows
    ]
