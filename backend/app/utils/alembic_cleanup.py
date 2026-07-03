import asyncio
import logging
from sqlalchemy import text
from app.database import AsyncSessionLocal

logger = logging.getLogger(__name__)

async def cleanup_alembic():
    async with AsyncSessionLocal() as db:
        try:
            res = await db.execute(text("SELECT version_num FROM alembic_version"))
            row = res.scalar()
            if row in ("fc465c3aec2f", "1c85ec8ff435", "9633eb1124b1"):
                print(f"Detected rolled-back alembic version {row} in production DB. Resetting local alembic_version to 2abb14031d2a...")
                await db.execute(text("UPDATE alembic_version SET version_num = '2abb14031d2a'"))
                await db.commit()
                print("Database alembic version successfully reset.")
            elif row == "4401ccb0df6f":
                print(f"Detected missing/phantom alembic version {row} in production DB. Resetting local alembic_version to head (8a1c56d19deb)...")
                await db.execute(text("UPDATE alembic_version SET version_num = '8a1c56d19deb'"))
                await db.commit()
                print("Database alembic version successfully reset to head.")
        except Exception as e:
            print("Alembic database cleanup check failed (this is normal if migrations haven't run yet):", e)

if __name__ == "__main__":
    asyncio.run(cleanup_alembic())
