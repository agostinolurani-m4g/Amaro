from sqlalchemy import Column, Date, DateTime, ForeignKey, Integer, String, Text, func
from sqlalchemy.orm import Mapped, relationship

from .database import Base


class Event(Base):
    __tablename__ = "events"

    id: Mapped[int] = Column(Integer, primary_key=True)
    title: Mapped[str] = Column(String(160), nullable=False)
    slug: Mapped[str] = Column(String(160), unique=True, nullable=False)
    description: Mapped[str | None] = Column(Text)
    location: Mapped[str | None] = Column(String(120))
    summary: Mapped[str | None] = Column(Text)
    date: Mapped[Date | None] = Column(Date)
    hero_quote: Mapped[str | None] = Column(String(240))
    teaser: Mapped[str | None] = Column(String(240))


class MerchItem(Base):
    __tablename__ = "merch_items"

    id: Mapped[int] = Column(Integer, primary_key=True)
    name: Mapped[str] = Column(String(140), nullable=False)
    slug: Mapped[str] = Column(String(140), unique=True, nullable=False)
    description: Mapped[str | None] = Column(Text)
    price_cents: Mapped[int] = Column(Integer, default=0)
    stock: Mapped[int] = Column(Integer, default=0)
    image_url: Mapped[str | None] = Column(String(255))


class Member(Base):
    __tablename__ = "members"

    id: Mapped[int] = Column(Integer, primary_key=True)
    name: Mapped[str] = Column(String(200), nullable=False)
    first_name: Mapped[str] = Column(String(80), nullable=False)
    last_name: Mapped[str] = Column(String(80), nullable=False)
    email: Mapped[str] = Column(String(140), nullable=False)
    birth_date: Mapped[Date | None] = Column(Date)
    birth_place: Mapped[str | None] = Column(String(140))
    residence: Mapped[str | None] = Column(String(220))
    codice_fiscale: Mapped[str | None] = Column(String(32))
    document_type: Mapped[str | None] = Column(String(80))
    document_number: Mapped[str | None] = Column(String(60))
    document_id: Mapped[str | None] = Column(String(90))
    tessera_sanitaria: Mapped[str | None] = Column(String(80))
    medical_certificate: Mapped[str | None] = Column(Text)
    medical_certificate_expiry: Mapped[Date | None] = Column(Date)
    membership_type: Mapped[str] = Column(String(80), nullable=False)
    message: Mapped[str | None] = Column(Text)
    payment_status: Mapped[str] = Column(String(60), default="pending")
    payment_reference: Mapped[str | None] = Column(String(120))
    access_code: Mapped[str | None] = Column(String(80))
    password_hash: Mapped[str | None] = Column(String(200))
    created_at: Mapped[DateTime] = Column(
        DateTime(timezone=True), server_default=func.now()
    )
    documents: Mapped[list["MemberDocument"]] = relationship(
        "MemberDocument", back_populates="member", cascade="all, delete-orphan"
    )


class MemberDocument(Base):
    __tablename__ = "member_documents"

    id: Mapped[int] = Column(Integer, primary_key=True)
    member_id: Mapped[int] = Column(ForeignKey("members.id"), nullable=False)
    original_name: Mapped[str] = Column(String(255), nullable=False)
    stored_filename: Mapped[str] = Column(String(255), nullable=False)
    content_type: Mapped[str | None] = Column(String(120))
    uploaded_at: Mapped[DateTime] = Column(
        DateTime(timezone=True), server_default=func.now()
    )
    member: Mapped["Member"] = relationship("Member", back_populates="documents")
