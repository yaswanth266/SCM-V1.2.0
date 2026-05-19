"""MR demand-pool bucket — staging for procurement decisions.

Created 2026-04-30 as part of the SCM workflow rebuild.

When a Warehouse Manager marks an indent line as 'procure' on the stock-decision
page, a row is added here. The MRP bucket runner periodically consumes pooled
buckets and creates draft Material Requests grouped by warehouse and required-date
week.
"""
from sqlalchemy import (Column, BigInteger, Numeric, Date, DateTime, Enum,
                       ForeignKey, Index, func)
from sqlalchemy.orm import relationship
from app.database import Base


class MrBucket(Base):
    __tablename__ = 'mr_buckets'

    id = Column(BigInteger, primary_key=True)
    indent_item_id = Column(BigInteger, ForeignKey('indent_items.id'), nullable=False)
    warehouse_id = Column(BigInteger, ForeignKey('warehouses.id'), nullable=False)
    item_id = Column(BigInteger, ForeignKey('items.id'), nullable=False)
    qty = Column(Numeric(15, 3), nullable=False)
    required_date = Column(Date, nullable=False)
    status = Column(Enum('pooled', 'in_run', 'in_mr', name='mr_bucket_status'),
                    nullable=False, server_default='pooled')
    mrp_run_id = Column(BigInteger, ForeignKey('mrp_runs.id'), nullable=True)
    material_request_id = Column(BigInteger, ForeignKey('material_requests.id'), nullable=True)
    created_at = Column(DateTime, server_default=func.current_timestamp(), nullable=False)

    indent_item = relationship('IndentItem', foreign_keys=[indent_item_id])
    warehouse = relationship('Warehouse')
    item = relationship('Item')
    mrp_run = relationship('MRPRun')
    material_request = relationship('MaterialRequest')

    __table_args__ = (
        Index('idx_bucket_window', 'warehouse_id', 'required_date', 'status'),
        Index('idx_bucket_indent_item', 'indent_item_id'),
        Index('idx_bucket_mr', 'material_request_id'),
    )
