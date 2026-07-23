from fastapi import APIRouter, Depends, HTTPException, status, Query
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, update, delete, or_
from typing import List, Optional

from app.database import get_db
from app.utils.dependencies import get_current_user, require_permission
from app.models.user import User
from app.models.vehicles import Vehicle
from app.schemas.master import VehicleCreate, VehicleResponse

router = APIRouter()


@router.get("", response_model=List[VehicleResponse])
async def list_vehicles(
    db: AsyncSession = Depends(get_db),
    search: Optional[str] = Query(None, description="Search by code or number"),
    is_active: Optional[bool] = Query(None),
    limit: int = Query(100, ge=1, le=1000),
    current_user: User = Depends(get_current_user),
):
    query = select(Vehicle)
    if is_active is not None:
        query = query.where(Vehicle.is_active == is_active)

    if search:
        search_pattern = f"%{search}%"
        query = query.where(
            or_(
                Vehicle.vehicle_code.ilike(search_pattern),
                Vehicle.vehicle_number.ilike(search_pattern),
            )
        )
    query = query.order_by(Vehicle.vehicle_code).limit(limit)
    result = await db.execute(query)
    return result.scalars().all()


@router.post("", response_model=VehicleResponse, status_code=201)
async def create_vehicle(
    payload: VehicleCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_permission("inventory-masters", "create", "inventory-masters")),
):
    # Check duplicate code
    exist_code_res = await db.execute(select(Vehicle).where(Vehicle.vehicle_code == payload.vehicle_code))
    if exist_code_res.scalar_one_or_none():
        raise HTTPException(status_code=400, detail="Vehicle code already exists")

    # Check duplicate number
    exist_num_res = await db.execute(select(Vehicle).where(Vehicle.vehicle_number == payload.vehicle_number))
    if exist_num_res.scalar_one_or_none():
        raise HTTPException(status_code=400, detail="Vehicle registration number already exists")

    vehicle = Vehicle(
        vehicle_code=payload.vehicle_code,
        vehicle_number=payload.vehicle_number,
        is_active=payload.is_active if payload.is_active is not None else True,
    )
    db.add(vehicle)
    await db.commit()
    await db.refresh(vehicle)
    return vehicle


@router.put("/{vehicle_id}", response_model=VehicleResponse)
async def update_vehicle(
    vehicle_id: int,
    payload: VehicleCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_permission("inventory-masters", "edit", "inventory-masters")),
):
    res = await db.execute(select(Vehicle).where(Vehicle.id == vehicle_id))
    vehicle = res.scalar_one_or_none()
    if not vehicle:
        raise HTTPException(status_code=404, detail="Vehicle not found")

    # Check duplicates for code
    exist_code = await db.execute(
        select(Vehicle).where(Vehicle.vehicle_code == payload.vehicle_code, Vehicle.id != vehicle_id)
    )
    if exist_code.scalar_one_or_none():
        raise HTTPException(status_code=400, detail="Vehicle code already exists")

    # Check duplicates for number
    exist_num = await db.execute(
        select(Vehicle).where(Vehicle.vehicle_number == payload.vehicle_number, Vehicle.id != vehicle_id)
    )
    if exist_num.scalar_one_or_none():
        raise HTTPException(status_code=400, detail="Vehicle registration number already exists")

    vehicle.vehicle_code = payload.vehicle_code
    vehicle.vehicle_number = payload.vehicle_number
    if payload.is_active is not None:
        vehicle.is_active = payload.is_active

    await db.commit()
    await db.refresh(vehicle)
    return vehicle


@router.delete("/{vehicle_id}")
async def delete_vehicle(
    vehicle_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_permission("inventory-masters", "delete", "inventory-masters")),
):
    res = await db.execute(select(Vehicle).where(Vehicle.id == vehicle_id))
    vehicle = res.scalar_one_or_none()
    if not vehicle:
        raise HTTPException(status_code=404, detail="Vehicle not found")

    await db.delete(vehicle)
    await db.commit()
    return {"message": "Vehicle deleted successfully"}
