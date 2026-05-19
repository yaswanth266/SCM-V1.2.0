import asyncio
from app.database import AsyncSessionLocal
from app.api.v1.indent import get_indent
from app.models.user import User

async def main():
    async with AsyncSessionLocal() as db:
        user = User(id=24, username="scm.support")
        try:
            # Indent 00133 might not have id 133, let's find it
            from sqlalchemy import select
            from app.models.indent import Indent
            res = await db.execute(select(Indent).where(Indent.indent_number.like('%00133%')))
            ind = res.scalar_one_or_none()
            if not ind:
                print("Indent not found")
                return
            indent_data = await get_indent(indent_id=ind.id, db=db, current_user=user)
            print("Indent items:")
            for item in indent_data.items:
                print(f"item_id: {item.item_id}, requested_qty: {item.requested_qty}")
        except Exception as e:
            print(f"Error: {e}")

if __name__ == "__main__":
    asyncio.run(main())
