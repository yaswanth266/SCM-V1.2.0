from pydantic import BaseModel, ConfigDict
from typing import List, Optional

class PackagingLevelResponse(BaseModel):
    id: int
    level_name: str
    level_order: int
    
    model_config = ConfigDict(from_attributes=True)

class ItemPackagingUpsertItem(BaseModel):
    id: Optional[int] = None
    level_id: int
    parent_id: Optional[int] = None
    qty_per_parent: int
    sku_code: Optional[str] = None

class ItemPackagingUpsertRequest(BaseModel):
    packagings: List[ItemPackagingUpsertItem]

class ItemPackagingResponse(BaseModel):
    id: int
    item_id: int
    level_id: int
    parent_id: Optional[int]
    qty_per_parent: int
    total_base_qty: int
    sku_code: Optional[str]
    sku_name: str
    level: Optional[PackagingLevelResponse] = None

    model_config = ConfigDict(from_attributes=True)


class PackagingLevelCreate(BaseModel):
    level_name: str
    level_order: int

