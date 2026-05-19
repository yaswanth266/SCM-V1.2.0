from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.master import Employee, Position
from app.models.user import Role, User, UserRole


async def sync_user_position_role(db: AsyncSession, user: User) -> Role | None:
    """Ensure a login user acts as the role assigned to their employee position."""
    if not user or not user.employee_id:
        return None

    role = (
        await db.execute(
            select(Role)
            .join(Position, Position.role_id == Role.id)
            .join(Employee, Employee.position_id == Position.id)
            .where(Employee.id == user.employee_id, Role.is_active == True)  # noqa: E712
        )
    ).scalar_one_or_none()
    if role is None:
        return None

    existing = (
        await db.execute(
            select(UserRole).where(
                UserRole.user_id == user.id,
                UserRole.role_id == role.id,
            )
        )
    ).scalar_one_or_none()
    if existing is None:
        db.add(UserRole(user_id=user.id, role_id=role.id))

    if user.active_role_id != role.id:
        user.active_role_id = role.id

    await db.flush()
    return role
