import logging
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from app.models.warehouse import SerialNumber

logger = logging.getLogger(__name__)

async def get_max_system_serial_number(db: AsyncSession) -> int:
    """Find the maximum system-generated serial number in the DB."""
    res = await db.execute(select(SerialNumber.serial_number, SerialNumber.asset_code, SerialNumber.consumable_code))
    sns = []
    for r_sn, r_ac, r_cc in res.all():
        for r in [r_sn, r_ac, r_cc]:
            if not r:
                continue
            r = r.strip()
            # Case 1: Standalone serial number
            if r.isdigit():
                sns.append(int(r))
                continue
            # Case 2: Old format (1-{serial_number}-{material_code})
            if r.startswith("1-"):
                parts = r.split("-")
                if len(parts) >= 2:
                    serial_part = parts[1]
                    if serial_part.isdigit():
                        sns.append(int(serial_part))
                        continue
            # Case 3: New format ({material_code}-1-{serial_number})
            # Since material_code can contain hyphens, we check if the string ends with "-1-{some_number}"
            parts = r.split("-")
            if len(parts) >= 3 and parts[-2] == "1":
                serial_part = parts[-1]
                if serial_part.isdigit():
                    sns.append(int(serial_part))

    return max(sns) if sns else 0

async def get_next_system_serial_number(db: AsyncSession, offset: int = 0) -> str:
    """Get the next system-generated serial number.
    Uses get_max_system_serial_number to find the maximum value, and returns the next sequential number plus the offset.
    """
    max_val = await get_max_system_serial_number(db)
    next_val = max_val + 1 + offset
    return str(next_val)

def generate_asset_code(serial_number: str, material_code: str) -> str:
    """Generate asset/consumable code according to format {material_code}-1-{serial_number}."""
    return f"{material_code.strip()}-1-{serial_number.strip()}"
