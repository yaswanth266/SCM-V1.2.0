# Facade for master models to preserve backward compatibility for direct imports
from app.models.inventory_master import (
    UOMCategory, UOM, UOMConversion, ItemUOMConversion, ItemCategory, ItemType,
    Feature, Item, MasterItemKitComponent, PackagingLevel, ItemPackaging,
    PriceList, PriceListItem, Brand, ItemAttribute, ItemAttributeValue,
    SpecCategory, Spec, ItemSpec, ItemSpecValue, ItemFeature, BOM, BOMComponent,
    RoleItemPermission
)
from app.models.procurement_master import (
    Vendor, VendorType, VendorCategory, VendorVendorType, VendorItem,
    VendorItemHistory, VendorContract, VendorRating, Customer
)
from app.models.settings_master import (
    UserGroup, UserGroupMember, UserGroupPermission, UserItemPermission,
    Office, Position, Employee
)
from app.models.vehicles import Vehicle
from app.models.project_templates import ProjectIndentTemplate, ProjectIndentTemplateItem

