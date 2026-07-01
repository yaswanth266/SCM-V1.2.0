from sqlalchemy import Column, BigInteger, String, DateTime, ForeignKey, Numeric, UniqueConstraint
from sqlalchemy.orm import relationship
from datetime import datetime, timezone
from app.database import Base


class ProjectIndentTemplate(Base):
    __tablename__ = "project_indent_templates"
    __table_args__ = (
        UniqueConstraint("project_id", "template_type", name="uq_project_template_type"),
    )

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    project_id = Column(BigInteger, ForeignKey("projects.id", ondelete="CASCADE"), nullable=False)
    template_type = Column(String(50), nullable=False)  # consumables, install
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc), nullable=False)
    updated_at = Column(DateTime, default=lambda: datetime.now(timezone.utc), onupdate=lambda: datetime.now(timezone.utc), nullable=False)

    project = relationship("Project")
    items = relationship("ProjectIndentTemplateItem", back_populates="template", cascade="all, delete-orphan")


class ProjectIndentTemplateItem(Base):
    __tablename__ = "project_indent_template_items"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    template_id = Column(BigInteger, ForeignKey("project_indent_templates.id", ondelete="CASCADE"), nullable=False)
    item_id = Column(BigInteger, ForeignKey("items.id", ondelete="CASCADE"), nullable=False)
    quantity = Column(Numeric(15, 3), nullable=False)
    uom_id = Column(BigInteger, ForeignKey("uom.id", ondelete="SET NULL"), nullable=True)

    template = relationship("ProjectIndentTemplate", back_populates="items")
    item = relationship("Item")
    uom = relationship("UOM")
