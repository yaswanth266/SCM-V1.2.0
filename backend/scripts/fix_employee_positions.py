import asyncio
import os
import sys

sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from sqlalchemy import text
from app.database import AsyncSessionLocal

async def main():
    print("=== DATABASE FIX MIGRATION STARTING ===")
    async with AsyncSessionLocal() as db:
        async with db.begin():
            # 1. Resolve Sivakrishna ID clash (move SRIDHAR MODARPATHI ID from 12259 to 17000)
            # Check if employee 12259 exists
            res = await db.execute(text("SELECT employee_code, name FROM employees WHERE id = 12259"))
            row = res.fetchone()
            if row:
                code, name = row
                print(f"Found employee 12259: Code={code}, Name={name}")
                if code == "HR-EMP-17000" or "SRIDHAR" in name.upper():
                    print("Clash detected with SRIDHAR MODARPATHI. Moving ID to 17000...")
                    # Temporarily disable foreign key checks for the updates
                    await db.execute(text("SET FOREIGN_KEY_CHECKS = 0"))
                    
                    # Update employee ID
                    await db.execute(text("UPDATE employees SET id = 17000 WHERE id = 12259"))
                    print("Updated employees ID 12259 -> 17000")
                    
                    # Update references in positions
                    await db.execute(text("UPDATE positions SET employee_id = 17000 WHERE employee_id = 12259"))
                    print("Updated positions referencing employee_id 12259 -> 17000")
                    
                    # Update references in users
                    await db.execute(text("UPDATE users SET employee_id = 17000 WHERE employee_id = 12259"))
                    print("Updated users referencing employee_id 12259 -> 17000")
                    
                    await db.execute(text("SET FOREIGN_KEY_CHECKS = 1"))
                else:
                    print("Employee 12259 is not SRIDHAR. Skipping ID move.")
            else:
                print("Employee 12259 not found. No clash to resolve.")

            # 2. Pre-link George (set employee_code = 'HR-EMP-12269' for user george)
            res_user = await db.execute(text("SELECT id, employee_code FROM users WHERE username = 'george'"))
            user_row = res_user.fetchone()
            if user_row:
                uid, ucode = user_row
                print(f"Found user george: ID={uid}, Current Code={ucode}")
                if ucode != "HR-EMP-12269":
                    await db.execute(text("UPDATE users SET employee_code = 'HR-EMP-12269' WHERE id = :uid"), {"uid": uid})
                    print("Updated user george employee_code to 'HR-EMP-12269'")
            else:
                print("User george not found in users table.")

            # 3. Clean up redundant seeded positions 5999 and 5996
            for pid in (5999, 5996):
                res_pos = await db.execute(text("SELECT id, code, name FROM positions WHERE id = :pid"), {"pid": pid})
                pos_row = res_pos.fetchone()
                if pos_row:
                    print(f"Found redundant position: ID={pos_row[0]}, Code={pos_row[1]}, Name={pos_row[2]}")
                    await db.execute(text("DELETE FROM positions WHERE id = :pid"), {"pid": pid})
                    print(f"Deleted position {pid}")
                else:
                    print(f"Redundant position {pid} not found or already deleted.")
                    
    print("=== DATABASE FIX MIGRATION COMPLETED ===")

if __name__ == "__main__":
    asyncio.run(main())
