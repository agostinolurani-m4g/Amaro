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

SAMPLE_MERCH = SAMPLE_MERCH = [
    {
        "slug": "maglia-bici-racing-aero",
        "name": "Maglia Bici Racing/Aero",
        "description": (
            "Maglia bici modello Racing/Aero, ispirata ai colori Amaro, "
            "pensata per le uscite più veloci e le granfondo."
        ),
        "price_cents": 7500,  # 75 euro
        "stock": 0,
        "image_url": "img/maglia-bici-racing-aero.jpg",
    },
    {
        "slug": "maglia-bici-amateur",
        "name": "Maglia Bici Amateur",
        "description": (
            "Maglia bici modello Amateur, più confortevole ma sempre con "
            "grafica Amaro e taglio tecnico."
        ),
        "price_cents": 5500,  # 55 euro
        "stock": 0,
        "image_url": "img/maglia-bici-amateur.jpg",
    },
    {
        "slug": "bib-racing-pro",
        "name": "Bib Racing/Pro",
        "description": (
            "Pantaloncino con bretelle modello Racing/Pro, fondello ad alte "
            "prestazioni per uscite e gare lunghe."
        ),
        "price_cents": 8500,  # 85 euro
        "stock": 0,
        "image_url": "img/bib-racing-pro.jpg",
    },
    {
        "slug": "bib-amateur",
        "name": "Bib Amateur",
        "description": (
            "Pantaloncino con bretelle modello Amateur, pensato per chi vuole "
            "comfort e stile Amaro nelle uscite quotidiane."
        ),
        "price_cents": 6800,  # 68 euro
        "stock": 0,
        "image_url": "img/bib-amateur.jpg",
    },
    {
        "slug": "gilet-smanicato",
        "name": "Smanicato",
        "description": (
            "Gilet smanicato antivento leggero, perfetto per discese e mezze "
            "stagioni, in tinta con la divisa Amaro."
        ),
        "price_cents": 6500,  # 65 euro
        "stock": 0,
        "image_url": "img/gilet-smanicato.jpg",
    },
    {
        "slug": "giacca-antipioggia",
        "name": "Antipioggia",
        "description": (
            "Giacca antipioggia tecnica ad alta visibilità, pensata per le "
            "uscite sotto l'acqua e in condizioni meteo difficili."
        ),
        "price_cents": 12000,  # 120 euro
        "stock": 0,
        "image_url": "img/giacca-antipioggia.jpg",
    },
    {
        "slug": "body-strada",
        "name": "Body Strada",
        "description": (
            "Body strada a maniche corte, taglio aerodinamico per gare e "
            "crono, con grafica completa Amaro."
        ),
        "price_cents": 14800,  # 148 euro
        "stock": 0,
        "image_url": "img/body-strada.jpg",
    },
    {
        "slug": "maglia-running",
        "name": "Maglia Running",
        "description": (
            "Maglia tecnica da running leggera e traspirante, con design Amaro "
            "coordinato all'abbigliamento bici."
        ),
        "price_cents": 3500,  # 35 euro
        "stock": 0,
        "image_url": "img/maglia-running.jpg",
    },
    {
        "slug": "maglia-sociale-roja",
        "name": "Maglia Sociale Roja",
        "description": (
            "Maglia sociale bianca 'Roja' con grafica Amaro stilizzata, "
            "pensata per l'uso quotidiano e il dopo-ride."
        ),
        "price_cents": 1500,  # 15 euro
        "stock": 0,
        "image_url": "img/maglia-sociale-roja.jpg",
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
