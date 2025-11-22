from __future__ import annotations

from datetime import date

from sqlalchemy.orm import Session

from .models import Event, MerchItem

SAMPLE_EVENTS = [
    {
        "slug": "open-day-primavera",
        "title": "Open Day primavera",
        "description": "Una giornata all'aperto dedicata alla musica, allo sport e alla cultura locale.",
        "location": "Parco Centrale, Amaro",
        "date": date(2026, 3, 21),
        "hero_quote": "Cresciamo insieme tra arte e movimento.",
        "summary": "Laboratori di danza, jam session e percorsi inclusivi per famiglie.",
    },
    {
        "slug": "river-folk-festival",
        "title": "River Folk Festival",
        "description": "Tre giorni di concerti folk, incontri e street food sul lungofiume.",
        "location": "Lungofiume Gora",
        "date": date(2026, 5, 8),
        "hero_quote": "Radici profonde, spirito libero.",
        "summary": "Artisti nazionali e internazionali, con workshop di liuteria inclusi.",
    },
    {
        "slug": "notte-delle-culture",
        "title": "Notte delle culture",
        "description": "Una notte dedicata alle culture del mondo, con mostre, spettacoli e cucina collettiva.",
        "location": "Ex Manifattura",
        "date": date(2026, 6, 28),
        "hero_quote": "Storie che si intrecciano sotto lo stesso cielo.",
        "summary": "Performance di danza contemporanea, arti visive e conferenze partecipative.",
    },
]

SAMPLE_MERCH = [
    {
        "slug": "t-shirt-amarena",
        "name": "T-shirt Amarena",
        "description": "Maglietta in cotone organico con stampa serigrafata ispirata alle iniziative dell'associazione.",
        "price_cents": 2200,
        "stock": 18,
    },
    {
        "slug": "zaino-festival",
        "name": "Zaino River",
        "description": "Zaino tecnico impermeabile, pensato per chi partecipa a eventi outdoor e residenziali.",
        "price_cents": 4500,
        "stock": 6,
    },
    {
        "slug": "cappellino-bunker",
        "name": "Cappellino Bunker",
        "description": "Cappellino snapback con logo ricamato e visiera ricurva.",
        "price_cents": 1800,
        "stock": 12,
    },
]


def seed_sample_data(session: Session) -> None:
    for payload in SAMPLE_EVENTS:
        existing = session.query(Event).filter_by(slug=payload["slug"]).first()
        if existing:
            continue
        session.add(Event(**payload))

    for payload in SAMPLE_MERCH:
        existing = session.query(MerchItem).filter_by(slug=payload["slug"]).first()
        if existing:
            continue
        session.add(MerchItem(**payload))

    session.commit()
