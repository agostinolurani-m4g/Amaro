from sqlalchemy import and_, or_
from sqlalchemy.orm import Session

from .models import EventRegistration


def _ordered_registrations(session: Session, event_id: int) -> list[EventRegistration]:
    return (
        session.query(EventRegistration)
        .filter(EventRegistration.event_id == event_id)
        .order_by(
            EventRegistration.created_at.asc(),
            EventRegistration.id.asc(),
        )
        .all()
    )


def bib_number_for_registration_order(
    session: Session, registration: EventRegistration
) -> str:
    """Pettorale = posizione in ordine di iscrizione (1-based)."""
    if not registration.event_id:
        return "1"
    rank = (
        session.query(EventRegistration)
        .filter(
            EventRegistration.event_id == registration.event_id,
            or_(
                EventRegistration.created_at < registration.created_at,
                and_(
                    EventRegistration.created_at == registration.created_at,
                    EventRegistration.id <= registration.id,
                ),
            ),
        )
        .count()
    )
    return str(max(rank, 1))


def assign_bib_on_registration(
    session: Session, registration: EventRegistration
) -> None:
    registration.bib_number = bib_number_for_registration_order(session, registration)


def backfill_missing_bib_numbers(session: Session, event_id: int) -> int:
    """Assegna pettorali mancanti in ordine di iscrizione. Ritorna quanti aggiornati."""
    regs = _ordered_registrations(session, event_id)
    updated = 0
    for index, reg in enumerate(regs, start=1):
        if not (reg.bib_number or "").strip():
            reg.bib_number = str(index)
            updated += 1
    if updated:
        session.commit()
    return updated


def sync_all_bib_numbers(session: Session, event_id: int) -> int:
    """Rinumera tutti i pettorali 1..N in ordine di iscrizione."""
    regs = _ordered_registrations(session, event_id)
    updated = 0
    for index, reg in enumerate(regs, start=1):
        new_bib = str(index)
        if (reg.bib_number or "").strip() != new_bib:
            reg.bib_number = new_bib
            updated += 1
    if updated:
        session.commit()
    return updated
