from sqlalchemy import Column, Date, DateTime, ForeignKey, Integer, String, Text, Boolean, func
from sqlalchemy.orm import Mapped, relationship

from .database import Base

DOCUMENT_CATEGORY_IDENTITY = "Carta d'identita / Passaporto"
DOCUMENT_CATEGORY_HEALTH = "Tessera sanitaria"
DOCUMENT_CATEGORY_MEDICAL = "Certificato medico agonistico"

MEMBERSHIP_STATUS_PENDING = "da_tesserare"
MEMBERSHIP_STATUS_COMPLETED = "tesserato"


class Event(Base):
    __tablename__ = "events"

    id: Mapped[int] = Column(Integer, primary_key=True)
    title: Mapped[str] = Column(String(160), nullable=False)
    slug: Mapped[str] = Column(String(160), unique=True, nullable=False)
    description: Mapped[str | None] = Column(Text)
    activity: Mapped[str | None] = Column(String(120))
    location: Mapped[str | None] = Column(String(120))
    location_map_url: Mapped[str | None] = Column(String(255))
    summary: Mapped[str | None] = Column(Text)
    date: Mapped[Date | None] = Column(Date)
    hero_quote: Mapped[str | None] = Column(String(240))
    teaser: Mapped[str | None] = Column(String(240))
    cover_image_url: Mapped[str | None] = Column(String(255))
    gallery_urls: Mapped[str | None] = Column(Text)
    is_featured: Mapped[bool] = Column(Boolean, default=False)
    is_amaro_event: Mapped[bool] = Column(Boolean, default=False)
    require_first_name: Mapped[bool] = Column(Boolean, default=True)
    require_last_name: Mapped[bool] = Column(Boolean, default=True)
    require_email: Mapped[bool] = Column(Boolean, default=True)
    require_phone: Mapped[bool] = Column(Boolean, default=True)
    require_residence: Mapped[bool] = Column(Boolean, default=False)
    require_intolerances: Mapped[bool] = Column(Boolean, default=False)
    require_acsi_fci: Mapped[bool] = Column(Boolean, default=False)
    require_medical_certificate: Mapped[bool] = Column(Boolean, default=False)
    medical_certificate_policy: Mapped[str] = Column(
        String(20), default="optional"
    )  # none | optional | required (lungo resta sempre obbligo agonistico)
    route_option_mode: Mapped[str] = Column(
        String(20), default="distances"
    )  # distances | trail | corsa
    require_privacy_photo: Mapped[bool] = Column(Boolean, default=True)
    require_privacy_other: Mapped[bool] = Column(Boolean, default=True)
    registration_notes: Mapped[str | None] = Column(Text)
    documents_urls: Mapped[str | None] = Column(Text)
    instagram_url: Mapped[str | None] = Column(String(255))
    enable_lunch_option: Mapped[bool] = Column(Boolean, default=False)
    lunch_description: Mapped[str | None] = Column(Text)
    enable_discipline_option: Mapped[bool] = Column(Boolean, default=False)
    enable_route_option: Mapped[bool] = Column(Boolean, default=False)
    waiver_url: Mapped[str | None] = Column(String(255))
    require_waiver_upload: Mapped[bool] = Column(Boolean, default=False)
    require_waiver_acceptance: Mapped[bool] = Column(Boolean, default=False)
    enable_jersey: Mapped[bool] = Column(Boolean, default=False)
    jersey_description: Mapped[str | None] = Column(Text)
    jersey_sizes: Mapped[str | None] = Column(String(140))
    jersey_price_cents: Mapped[int | None] = Column(Integer)
    jersey_image_url_male: Mapped[str | None] = Column(String(255))
    jersey_image_url_female: Mapped[str | None] = Column(String(255))
    jersey_gallery_urls: Mapped[str | None] = Column(Text)
    jersey_gallery_link: Mapped[str | None] = Column(String(255))
    event_price_cents: Mapped[int | None] = Column(Integer)
    event_lunch_price_cents: Mapped[int | None] = Column(Integer)
    sponsors_urls: Mapped[str | None] = Column(Text)
    route_gpx_urls: Mapped[str | None] = Column(Text)
    event_activities_config: Mapped[str | None] = Column(Text)

    registrations: Mapped[list["EventRegistration"]] = relationship(
        "EventRegistration", back_populates="event", cascade="all, delete-orphan"
    )


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
    phone: Mapped[str | None] = Column(String(40))
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
    sport_type: Mapped[str | None] = Column(String(80))
    message: Mapped[str | None] = Column(Text)
    membership_status: Mapped[str] = Column(
        String(40), default=MEMBERSHIP_STATUS_PENDING
    )
    payment_status: Mapped[str] = Column(String(60), default="pending")
    payment_reference: Mapped[str | None] = Column(String(120))
    access_code: Mapped[str | None] = Column(String(80))
    password_hash: Mapped[str | None] = Column(String(200))
    password_reset_token_hash: Mapped[str | None] = Column(String(200))
    password_reset_expires_at: Mapped[DateTime | None] = Column(DateTime(timezone=True))
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
    document_category: Mapped[str | None] = Column(String(80))
    original_name: Mapped[str] = Column(String(255), nullable=False)
    stored_filename: Mapped[str] = Column(String(255), nullable=False)
    content_type: Mapped[str | None] = Column(String(120))
    uploaded_at: Mapped[DateTime] = Column(
        DateTime(timezone=True), server_default=func.now()
    )
    member: Mapped["Member"] = relationship("Member", back_populates="documents")


class MembershipPayment(Base):
    __tablename__ = "membership_payments"

    id: Mapped[int] = Column(Integer, primary_key=True)
    reference: Mapped[str] = Column(String(40), unique=True, nullable=False)
    email: Mapped[str | None] = Column(String(140))
    sport_type: Mapped[str] = Column(String(80), nullable=False)
    amount_cents: Mapped[int] = Column(Integer, nullable=False)
    status: Mapped[str] = Column(String(20), default="pending")
    created_at: Mapped[DateTime] = Column(
        DateTime(timezone=True), server_default=func.now()
    )
    paid_at: Mapped[DateTime | None] = Column(DateTime(timezone=True))
    member_id: Mapped[int | None] = Column(ForeignKey("members.id"))


class EventRegistration(Base):
    __tablename__ = "event_registrations"

    id: Mapped[int] = Column(Integer, primary_key=True)
    event_id: Mapped[int] = Column(ForeignKey("events.id"), nullable=False)
    first_name: Mapped[str | None] = Column(String(80))
    last_name: Mapped[str | None] = Column(String(80))
    email: Mapped[str | None] = Column(String(140))
    phone: Mapped[str | None] = Column(String(40))
    residence: Mapped[str | None] = Column(String(220))
    intolerances: Mapped[str | None] = Column(Text)
    privacy_photo: Mapped[bool] = Column(Boolean, default=False)
    privacy_other: Mapped[bool] = Column(Boolean, default=False)
    acsi_fci_original_name: Mapped[str | None] = Column(String(255))
    acsi_fci_stored_filename: Mapped[str | None] = Column(String(255))
    acsi_fci_content_type: Mapped[str | None] = Column(String(120))
    medical_original_name: Mapped[str | None] = Column(String(255))
    medical_stored_filename: Mapped[str | None] = Column(String(255))
    medical_content_type: Mapped[str | None] = Column(String(120))
    lunch_option: Mapped[str | None] = Column(String(40))
    lunch_guests: Mapped[int | None] = Column(Integer)
    team_name: Mapped[str | None] = Column(String(120))
    discipline: Mapped[str | None] = Column(String(40))
    route_length: Mapped[str | None] = Column(String(40))
    waiver_original_name: Mapped[str | None] = Column(String(255))
    waiver_stored_filename: Mapped[str | None] = Column(String(255))
    waiver_content_type: Mapped[str | None] = Column(String(120))
    waiver_accepted: Mapped[bool] = Column(Boolean, default=False)
    jersey_size: Mapped[str | None] = Column(String(40))
    jersey_gender: Mapped[str | None] = Column(String(40))
    payment_reference: Mapped[str | None] = Column(String(40))
    payment_status: Mapped[str | None] = Column(String(20))
    total_amount_cents: Mapped[int | None] = Column(Integer)
    created_at: Mapped[DateTime] = Column(
        DateTime(timezone=True), server_default=func.now()
    )

    event: Mapped["Event"] = relationship("Event", back_populates="registrations")
