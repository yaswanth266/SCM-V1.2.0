from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form
from fastapi.responses import StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func
from decimal import Decimal
import io
import csv
from datetime import datetime, date, timedelta
from typing import Optional, List, Dict, Any

from app.database import get_db
from app.models.user import User
from app.models.master import Item, ItemCategory, UOM
from app.models.warehouse import Warehouse, Batch
from app.utils.dependencies import get_current_user, require_permission
from app.services.item_coding import generate_item_code, ORG_PREFIX_DEFAULT
from app.api.v1.inventory import _item_readable_code
from app.services.stock_service import post_stock_ledger
from app.api.v1.warehouse import resolve_or_create_bin

router = APIRouter()

CSV_HEADERS = [
    "name", "item_type", "category_level_1", "category_level_2", "category_level_3",
    "primary_uom", "asset_code", "consumable_code", "purchase_price", "selling_price", "mrp", "tax_rate",
    "has_batch", "has_serial", "has_expiry", "shelf_life_days", "dosage_form", "valuation_method",
    "initial_quantity", "initial_warehouse", "initial_bin", "initial_batch_number", "initial_batch_expiry",
    "description"
]

def parse_bool(v: str, default: bool = False) -> bool:
    if not v:
        return default
    v_clean = str(v).strip().lower()
    if v_clean in ("yes", "y", "true", "t", "1"):
        return True
    if v_clean in ("no", "n", "false", "f", "0"):
        return False
    return default

def clean_decimal(v: str, default: Decimal = Decimal("0")) -> Decimal:
    if not v:
        return default
    try:
        return Decimal(str(v).strip())
    except Exception:
        return default

def clean_int(v: str, default: int = 0) -> int:
    if not v:
        return default
    try:
        return int(str(v).strip())
    except Exception:
        return default

def clean_date(v: str) -> Optional[date]:
    if not v:
        return None
    for fmt in ("%Y-%m-%d", "%d-%m-%Y", "%m/%d/%Y", "%d/%m/%Y"):
        try:
            return datetime.strptime(str(v).strip(), fmt).date()
        except ValueError:
            continue
    return None

@router.get("/items-bulk/template")
async def download_template(current_user: User = Depends(get_current_user)):
    """Downloads a sample CSV template for bulk uploading items."""
    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(CSV_HEADERS)
    # Add dummy row
    writer.writerow([
        "Paracetamol 650mg", "medicine", "Pharmaceuticals", "Analgesics", "Antipyretics",
        "Tablet", "", "", "12.50", "15.00", "18.00", "12.0",
        "Yes", "No", "Yes", "730", "Tablet", "fefo",
        "100", "Central Warehouse", "BIN-A1", "BATCH-PAR-01", "2028-12-31",
        "Standard analgesic paracetamol tablet."
    ])
    
    output.seek(0)
    return StreamingResponse(
        io.BytesIO(output.getvalue().encode("utf-8")),
        media_type="text/csv",
        headers={"Content-Disposition": "attachment; filename=items_bulk_upload_template.csv"}
    )

async def _bulk_upload_items_impl(
    file: UploadFile,
    dry_run: bool,
    db: AsyncSession,
    current_user: User
):
    contents = await file.read()
    try:
        import os
        os.makedirs("scratch", exist_ok=True)
        with open("scratch/debug_uploaded_file.csv", "wb") as f:
            f.write(contents)
    except Exception:
        pass
    # Seek back to 0 so reading again works
    await file.seek(0)
    try:
        decoded = contents.decode("utf-8-sig")
    except UnicodeDecodeError:
        try:
            decoded = contents.decode("latin-1")
        except Exception:
            raise HTTPException(status_code=400, detail="Unable to decode file. Please upload a UTF-8 encoded CSV.")

    reader = csv.DictReader(io.StringIO(decoded, newline=None))
    
    # Verify minimal headers are present
    headers = [h.strip().lower() for h in (reader.fieldnames or []) if h]
    required_fields = ["name", "item_type", "category_level_1", "category_level_2", "category_level_3", "primary_uom"]
    for rf in required_fields:
        if rf not in headers:
            raise HTTPException(
                status_code=400, 
                detail=f"Invalid template headers. Missing mandatory column: '{rf}'."
            )

    # 1. Pre-fetch lookups to avoid n+1 DB round-trips
    # Get all categories
    cat_res = await db.execute(select(ItemCategory).where(ItemCategory.is_active == True))
    all_categories = cat_res.scalars().all()
    # Categorize by parent mapping for hierarchical lookup
    cats_by_name = {}
    for c in all_categories:
        if c.name:
            cats_by_name[c.name.strip().lower()] = c
    cats_by_id = {c.id: c for c in all_categories}
    
    # Get all UOMs
    uom_res = await db.execute(select(UOM).where(UOM.is_active == True))
    all_uoms = uom_res.scalars().all()
    uoms_by_name = {}
    for u in all_uoms:
        if u.name:
            uoms_by_name[u.name.strip().lower()] = u
        if u.abbreviation:
            uoms_by_name[u.abbreviation.strip().lower()] = u

    # Get all Warehouses
    wh_res = await db.execute(select(Warehouse).where(Warehouse.is_active == True))
    all_warehouses = wh_res.scalars().all()
    whs_by_name = {}
    for w in all_warehouses:
        if w.name:
            whs_by_name[w.name.strip().lower()] = w
        if w.code:
            whs_by_name[w.code.strip().lower()] = w

    # Get all existing item names to prevent duplicates
    existing_item_names = set()
    ex_names_res = await db.execute(select(Item.name))
    for name in ex_names_res.scalars().all():
        if name:
            existing_item_names.add(name.strip().lower())

    report = []
    has_errors = False
    valid_rows_count = 0
    error_rows_count = 0
    
    processed_names_in_file = set()
    
    # Parse rows
    rows_to_insert = []
    
    for idx, row in enumerate(reader, start=1):
        # Normalize keys
        cleaned_row = {k.strip().lower(): v for k, v in row.items() if k}
        
        name = (cleaned_row.get("name") or "").strip()
        item_type = (cleaned_row.get("item_type") or "").strip().lower()
        cat_l1 = (cleaned_row.get("category_level_1") or "").strip()
        cat_l2 = (cleaned_row.get("category_level_2") or "").strip()
        cat_l3 = (cleaned_row.get("category_level_3") or "").strip()
        uom_str = (cleaned_row.get("primary_uom") or "").strip()
        
        # Skip completely empty rows (common at the end of Excel-to-CSV exports)
        if not name and not item_type and not cat_l1 and not cat_l2 and not cat_l3 and not uom_str:
            continue
            
        row_errors = []
        row_warnings = []
        
        # 1. Required field validations
        if not name:
            row_errors.append("Item Name is required.")
        if not item_type:
            row_errors.append("Item Type is required.")
        if not cat_l1 or not cat_l2 or not cat_l3:
            row_errors.append("Category Level 1, Level 2, and Level 3 are all mandatory.")
        if not uom_str:
            row_errors.append("Primary UOM is required.")
            
        # Unique name validations
        if name:
            name_lower = name.lower()
            if name_lower in processed_names_in_file:
                row_errors.append(f"Duplicate item name '{name}' found in this upload file.")
            elif name_lower in existing_item_names:
                row_errors.append(f"Item with name '{name}' already exists in database.")
            processed_names_in_file.add(name_lower)

        # 2. Category Hierarchy Resolution
        resolved_category_id = None
        if cat_l1 and cat_l2 and cat_l3:
            l1_cat = cats_by_name.get(cat_l1.lower())
            if not l1_cat:
                row_errors.append(f"Category Level 1 '{cat_l1}' not found or inactive.")
            else:
                l2_cat = None
                for c in all_categories:
                    if c.name and c.name.strip().lower() == cat_l2.lower() and c.parent_id == l1_cat.id:
                        l2_cat = c
                        break
                if not l2_cat:
                    row_errors.append(f"Category Level 2 '{cat_l2}' not found under Level 1 '{cat_l1}'.")
                else:
                    l3_cat = None
                    for c in all_categories:
                        if c.name and c.name.strip().lower() == cat_l3.lower() and c.parent_id == l2_cat.id:
                            l3_cat = c
                            break
                    if not l3_cat:
                        row_errors.append(f"Category Level 3 '{cat_l3}' not found under Level 2 '{cat_l2}'.")
                    else:
                        resolved_category_id = l3_cat.id

        # 3. UOM Resolution
        resolved_uom = None
        if uom_str:
            resolved_uom = uoms_by_name.get(uom_str.lower())
            if not resolved_uom:
                row_errors.append(f"UOM '{uom_str}' not found or inactive.")

        # 4. Decimal and number validations
        purchase_price = clean_decimal(cleaned_row.get("purchase_price"))
        selling_price = clean_decimal(cleaned_row.get("selling_price"))
        mrp = clean_decimal(cleaned_row.get("mrp"))
        tax_rate = clean_decimal(cleaned_row.get("tax_rate"))
        
        if purchase_price < 0:
            row_errors.append("Purchase price cannot be negative.")
        if selling_price < 0:
            row_errors.append("Selling price cannot be negative.")
        if mrp < 0:
            row_errors.append("MRP cannot be negative.")
        if tax_rate < 0:
            row_errors.append("Tax rate cannot be negative.")

        # 5. Opening Stock validation
        initial_qty = clean_decimal(cleaned_row.get("initial_quantity"))
        initial_warehouse_id = None
        initial_bin_code = (cleaned_row.get("initial_bin") or "").strip() or "SYSTEM-DEFAULT"
        initial_batch_number = (cleaned_row.get("initial_batch_number") or "").strip() or "INITIAL-BATCH"
        initial_expiry_date = clean_date(cleaned_row.get("initial_batch_expiry"))
        
        if initial_qty > 0:
            wh_str = (cleaned_row.get("initial_warehouse") or "").strip()
            if not wh_str:
                row_warnings.append("No initial warehouse specified for opening stock. Falling back to 'Central'.")
            else:
                wh_obj = whs_by_name.get(wh_str.lower())
                if not wh_obj:
                    row_errors.append(f"Initial warehouse '{wh_str}' not found or inactive.")
                else:
                    initial_warehouse_id = wh_obj.id

            if (cleaned_row.get("initial_batch_expiry") or "").strip() and not initial_expiry_date:
                row_errors.append("Invalid initial_batch_expiry format. Use YYYY-MM-DD.")

        # Collect report status
        if row_errors:
            has_errors = True
            error_rows_count += 1
            status = "invalid"
        else:
            valid_rows_count += 1
            status = "valid"
            
            # Prepare insertion details
            rows_to_insert.append({
                "row_index": idx,
                "name": name,
                "description": (cleaned_row.get("description") or "").strip() or None,
                "item_type": item_type,
                "category_id": resolved_category_id,
                "primary_uom_id": resolved_uom.id if resolved_uom else None,
                "purchase_price": purchase_price,
                "selling_price": selling_price,
                "mrp": mrp,
                "tax_rate": tax_rate,
                "asset_code": (cleaned_row.get("asset_code") or "").strip() or None,
                "consumable_code": (cleaned_row.get("consumable_code") or "").strip() or None,
                "has_batch": parse_bool(cleaned_row.get("has_batch")),
                "has_serial": parse_bool(cleaned_row.get("has_serial")),
                "has_expiry": parse_bool(cleaned_row.get("has_expiry")),
                "shelf_life_days": clean_int(cleaned_row.get("shelf_life_days")),
                "dosage_form": (cleaned_row.get("dosage_form") or "").strip() or None,
                "valuation_method": (cleaned_row.get("valuation_method") or "fifo").strip().lower(),
                "initial_quantity": initial_qty,
                "initial_warehouse_id": initial_warehouse_id,
                "initial_bin_code": initial_bin_code,
                "initial_batch_number": initial_batch_number,
                "initial_batch_expiry": initial_expiry_date,
            })

        report.append({
            "row_index": idx,
            "name": name or f"[Row {idx}]",
            "status": status,
            "errors": row_errors,
            "warnings": row_warnings
        })

    # Return response if dry run
    if dry_run:
        return {
            "success": not has_errors,
            "total_rows": idx if 'idx' in locals() else 0,
            "valid_rows": valid_rows_count,
            "error_rows": error_rows_count,
            "report": report
        }

    # If committing and has errors, abort
    if has_errors:
        raise HTTPException(
            status_code=422,
            detail={
                "message": "Bulk upload failed due to validation errors. Please correct the file and try again.",
                "report": report
            }
        )

    # Insert items
    created_items = []
    try:
        for r_data in rows_to_insert:
            # Generate item code and readable code
            item_code = await generate_item_code(
                db,
                category_id=r_data["category_id"],
                dosage_form=r_data["dosage_form"],
                org_prefix=ORG_PREFIX_DEFAULT
            )
            readable_code = await _item_readable_code(db, r_data["category_id"], r_data["name"])

            # Create Item object
            item = Item(
                name=r_data["name"],
                description=r_data["description"],
                item_code=item_code,
                readable_code=readable_code,
                item_type=r_data["item_type"],
                category_id=r_data["category_id"],
                primary_uom_id=r_data["primary_uom_id"],
                purchase_price=r_data["purchase_price"],
                selling_price=r_data["selling_price"],
                mrp=r_data["mrp"],
                tax_rate=r_data["tax_rate"],
                asset_code=r_data["asset_code"],
                consumable_code=r_data["consumable_code"],
                has_batch=r_data["has_batch"],
                has_serial=r_data["has_serial"],
                has_expiry=r_data["has_expiry"],
                shelf_life_days=r_data["shelf_life_days"],
                dosage_form=r_data["dosage_form"] or ("unit" if r_data["item_type"] == "equipment" else None),
                valuation_method=r_data["valuation_method"],
                created_by=current_user.id,
                is_active=True
            )
            db.add(item)
            await db.flush()

            # Post opening stock ledger
            initial_qty = r_data["initial_quantity"]
            if initial_qty > 0:
                warehouse = None
                if r_data["initial_warehouse_id"]:
                    wh_res = await db.execute(select(Warehouse).where(Warehouse.id == r_data["initial_warehouse_id"]))
                    warehouse = wh_res.scalar_one_or_none()
                if not warehouse:
                    # Fallback to Central
                    wh_res = await db.execute(select(Warehouse).where(func.lower(Warehouse.name) == "central"))
                    warehouse = wh_res.scalar_one_or_none()
                if not warehouse:
                    fallback_res = await db.execute(select(Warehouse).where(Warehouse.is_active == True).limit(1))
                    warehouse = fallback_res.scalar_one_or_none()

                if warehouse:
                    # Resolve/create bin
                    bin_id = await resolve_or_create_bin(db, warehouse.id, r_data["initial_bin_code"])

                    # Resolve/create batch
                    batch_number = r_data["initial_batch_number"]
                    batch_result = await db.execute(
                        select(Batch).where(Batch.item_id == item.id, Batch.batch_number == batch_number)
                    )
                    batch = batch_result.scalar_one_or_none()
                    if not batch:
                        if r_data["initial_batch_expiry"]:
                            expiry_date = datetime.combine(r_data["initial_batch_expiry"], datetime.min.time())
                        else:
                            expiry_date = datetime.now() + timedelta(days=3650)
                        
                        batch = Batch(
                            item_id=item.id,
                            batch_number=batch_number,
                            expiry_date=expiry_date,
                            status="active"
                        )
                        db.add(batch)
                        await db.flush()
                    batch_id = batch.id

                    # Post opening ledger transaction
                    await post_stock_ledger(
                        db=db,
                        item_id=item.id,
                        warehouse_id=warehouse.id,
                        transaction_type="opening",
                        qty_in=initial_qty,
                        rate=item.purchase_price,
                        bin_id=bin_id,
                        batch_id=batch_id,
                        uom_id=item.primary_uom_id,
                        created_by=current_user.id
                    )

            created_items.append({
                "id": item.id,
                "item_code": item.item_code,
                "readable_code": item.readable_code,
                "name": item.name
            })

        await db.commit()
    except Exception as exc:
        await db.rollback()
        raise HTTPException(
            status_code=500,
            detail=f"An error occurred while importing items: {str(exc)}"
        )

    return {
        "success": True,
        "message": f"Successfully imported {len(created_items)} items.",
        "items": created_items
    }

@router.post("/items-bulk/upload")
async def bulk_upload_items(
    file: UploadFile = File(...),
    dry_run: bool = Form(True),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_permission("masters", "create", "items"))
):
    """
    Parses and imports items from CSV.
    Supports dry-run preview before committing to DB.
    """
    try:
        return await _bulk_upload_items_impl(file, dry_run, db, current_user)
    except HTTPException:
        raise
    except Exception as exc:
        import traceback
        traceback.print_exc()
        try:
            await db.rollback()
        except Exception:
            pass
        raise HTTPException(
            status_code=500,
            detail=f"An error occurred during bulk upload processing: {str(exc)}"
        )
