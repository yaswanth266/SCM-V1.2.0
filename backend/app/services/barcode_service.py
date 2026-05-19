import io
import json
import uuid
import base64
from typing import Optional
from datetime import datetime, timezone

import barcode
from barcode.writer import ImageWriter
import qrcode


def generate_barcode_value(entity_type: str, entity_id: int) -> str:
    """Generate a unique barcode value for an entity."""
    prefix_map = {
        "item": "ITM",
        "batch": "BAT",
        "serial": "SRL",
        "bin": "BIN",
        "pallet": "PLT",
        "package": "PKG",
        "gate_pass": "GP",
        "asset": "AST",
    }
    prefix = prefix_map.get(entity_type, "GEN")
    unique_part = str(uuid.uuid4().hex[:8]).upper()
    return f"{prefix}-{entity_id:06d}-{unique_part}"


def auto_detect_barcode_type(
    item_type: str,
    has_batch: bool,
    has_expiry: bool,
    has_serial: bool,
) -> str:
    """Auto-detect whether to use QR code or Code128 barcode.

    Logic:
    - Medicines, surgical items, biomedical equipment, or devices -> QR code
      (can encode batch / expiry / serial / device-UDI data).
    - Items with batch+expiry or serial tracking -> QR code.
    - General consumables / spares -> Code128 barcode.

    BUG-INV-100: previously only `medicine` triggered QR; surgical (SURG),
    biomedical equipment (BMEQ), and IT equipment (ITEQ) all carry batch /
    serial data that won't fit reliably in a Code128 symbol — they were
    silently downgraded to a barcode that could only encode the bare value
    and not the batch / expiry / UDI metadata operators need on the label.
    """
    QR_ITEM_TYPES = {
        "medicine", "pharma", "drug", "consumable_medicine",
        "surgical", "surg", "device", "biomedical", "bmeq",
        "it_equipment", "iteq", "implant",
    }
    if item_type and str(item_type).lower() in QR_ITEM_TYPES:
        return "qrcode"
    if has_batch and has_expiry:
        return "qrcode"
    if has_serial:
        return "qrcode"
    return "code128"


def generate_qr_code(
    barcode_value: str,
    item_code: Optional[str] = None,
    item_name: Optional[str] = None,
    batch_number: Optional[str] = None,
    expiry_date: Optional[str] = None,
    serial_number: Optional[str] = None,
    additional_data: Optional[dict] = None,
) -> bytes:
    """Generate a QR code image with encoded JSON data.

    For medicines and batch-tracked items, encodes:
    item code, batch number, expiry date, serial number.
    """
    qr_data = {
        "barcode": barcode_value,
    }
    if item_code:
        qr_data["item_code"] = item_code
    if item_name:
        qr_data["item_name"] = item_name
    if batch_number:
        qr_data["batch"] = batch_number
    if expiry_date:
        qr_data["expiry"] = expiry_date
    if serial_number:
        qr_data["serial"] = serial_number
    if additional_data:
        qr_data.update(additional_data)

    qr = qrcode.QRCode(
        version=None,
        error_correction=qrcode.constants.ERROR_CORRECT_M,
        box_size=10,
        border=4,
    )
    qr.add_data(json.dumps(qr_data))
    qr.make(fit=True)

    img = qr.make_image(fill_color="black", back_color="white")
    buffer = io.BytesIO()
    img.save(buffer, format="PNG")
    buffer.seek(0)
    return buffer.getvalue()


def generate_code128_barcode(barcode_value: str) -> bytes:
    """Generate a Code128 barcode image for general items."""
    code128 = barcode.get_barcode_class("code128")
    bc = code128(barcode_value, writer=ImageWriter())
    buffer = io.BytesIO()
    bc.write(buffer)
    buffer.seek(0)
    return buffer.getvalue()


def generate_barcode_image(
    barcode_type: str,
    barcode_value: str,
    item_code: Optional[str] = None,
    item_name: Optional[str] = None,
    batch_number: Optional[str] = None,
    expiry_date: Optional[str] = None,
    serial_number: Optional[str] = None,
) -> bytes:
    """Generate barcode or QR code image based on type."""
    if barcode_type == "qrcode":
        return generate_qr_code(
            barcode_value=barcode_value,
            item_code=item_code,
            item_name=item_name,
            batch_number=batch_number,
            expiry_date=expiry_date,
            serial_number=serial_number,
        )
    else:
        return generate_code128_barcode(barcode_value)


def get_label_data(
    barcode_value: str,
    barcode_type: str,
    item_code: Optional[str] = None,
    item_name: Optional[str] = None,
    batch_number: Optional[str] = None,
    expiry_date: Optional[str] = None,
    serial_number: Optional[str] = None,
    warehouse: Optional[str] = None,
    bin_location: Optional[str] = None,
) -> dict:
    """Get label print data including barcode image as base64."""
    image_bytes = generate_barcode_image(
        barcode_type=barcode_type,
        barcode_value=barcode_value,
        item_code=item_code,
        item_name=item_name,
        batch_number=batch_number,
        expiry_date=expiry_date,
        serial_number=serial_number,
    )

    return {
        "barcode_value": barcode_value,
        "barcode_type": barcode_type,
        "barcode_image_base64": base64.b64encode(image_bytes).decode("utf-8"),
        "item_code": item_code,
        "item_name": item_name,
        "batch_number": batch_number,
        "expiry_date": expiry_date,
        "serial_number": serial_number,
        "warehouse": warehouse,
        "bin_location": bin_location,
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }
