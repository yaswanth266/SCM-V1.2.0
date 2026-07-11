import asyncio
import os
import sys

sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from app.database import AsyncSessionLocal
from sqlalchemy import select
from app.models.user import Organization, Role, User, UserRole
from app.services.auth_service import hash_password

async def run():
    async with AsyncSessionLocal() as db:
        try:
            # 1. Organization
            org_code = "BHSPL"
            org_name = "Bavya Health Services Pvt Ltd"
            stmt = select(Organization).where(Organization.code == org_code)
            res_org = await db.execute(stmt)
            org = res_org.scalar_one_or_none()
            if not org:
                org = Organization(code=org_code, name=org_name, is_active=True)
                db.add(org)
                await db.flush()
                print(f"Created organization: {org_name} ({org_code}) with ID {org.id}")
            else:
                print(f"Organization already exists: {org.name} with ID {org.id}")

            # 2. Role
            role_code = "super_admin"
            role_name = "Super Admin"
            stmt = select(Role).where(Role.code == role_code)
            res_role = await db.execute(stmt)
            role = res_role.scalar_one_or_none()
            if not role:
                role = Role(
                    code=role_code,
                    name=role_name,
                    description="Super Administrator",
                    role_type="core",
                    is_active=True,
                    organization_id=org.id
                )
                db.add(role)
                await db.flush()
                print(f"Created role: {role_name} ({role_code}) with ID {role.id}")
            else:
                print(f"Role already exists: {role.name} with ID {role.id}")

            # 3. Hash Password
            password_raw = "admin@123"
            pwd_hash = hash_password(password_raw)

            # 4. User
            username = "admin"
            email = "admin@bhspl.com"
            stmt = select(User).where(User.username == username)
            res_user = await db.execute(stmt)
            user = res_user.scalar_one_or_none()
            if not user:
                user = User(
                    username=username,
                    email=email,
                    password_hash=pwd_hash,
                    first_name="Super",
                    last_name="Admin",
                    user_type="admin",
                    is_active=True,
                    organization_id=org.id,
                    active_role_id=role.id
                )
                db.add(user)
                await db.flush()
                print(f"Created user: {username} with ID {user.id}")
            else:
                user.password_hash = pwd_hash
                user.organization_id = org.id
                user.active_role_id = role.id
                user.is_active = True
                print(f"Updated user: {username} with ID {user.id}")

            # 5. UserRole
            stmt = select(UserRole).where(UserRole.user_id == user.id, UserRole.role_id == role.id)
            res_ur = await db.execute(stmt)
            user_role = res_ur.scalar_one_or_none()
            if not user_role:
                user_role = UserRole(user_id=user.id, role_id=role.id)
                db.add(user_role)
                print(f"Assigned user {username} to role {role_code}")
            else:
                print(f"User {username} already assigned to role {role_code}")

            await db.commit()
            print("Successfully committed transaction.")
        except Exception as e:
            await db.rollback()
            print(f"Error occurred, transaction rolled back: {e}")
            raise e

if __name__ == "__main__":
    asyncio.run(run())
