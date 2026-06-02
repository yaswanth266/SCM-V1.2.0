from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, or_
import json

from app.database import get_db
from app.models.user import User
from app.utils.dependencies import require_api_key_scope, require_stock_balance_scope

router = APIRouter()

@router.get("/masters/items")
async def get_items(
    limit: int = 100,
    offset: int = 0,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_api_key_scope("masters:items:read")),
):
    """Get all items (Master Data). Requires 'masters:read' scope."""
    from app.models.master import Item, RoleItemPermission
    from app.models.user import UserRole
    
    stmt = select(Item)
    if getattr(user, "used_api_key", None) and user.used_api_key.linked_user_ids:
        linked_ids = user.used_api_key.linked_user_ids
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
    if getattr(user, "used_api_key", None) and user.used_api_key.linked_user_ids:
        linked_ids = user.used_api_key.linked_user_ids
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

    # 2. Granular Scopes Filtering (based on Item Types & Serial tracking)
    # Only filter if "inventory:stock-balance:read" is NOT in scopes
    if "inventory:stock-balance:read" not in scopes:
        conditions = []
        for s in scopes:
            if s.startswith("inventory:stock-balance:") and s.endswith(":read"):
                # Format: inventory:stock-balance:<item_type>:<serial_status>:read
                inner = s[len("inventory:stock-balance:"):-len(":read")]
                if inner.endswith(":serial"):
                    item_type = inner[:-7]
                    conditions.append((item_type, True))
                elif inner.endswith(":non-serial"):
                    item_type = inner[:-11]
                    conditions.append((item_type, False))
        
        if conditions:
            if not is_item_joined:
                stmt = stmt.join(Item, Item.id == StockBalance.item_id)
                is_item_joined = True
            
            clause_list = []
            for it_type, has_ser in conditions:
                clause_list.append(
                    (Item.item_type == it_type) & (Item.has_serial == has_ser)
                )
            stmt = stmt.filter(or_(*clause_list))
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
