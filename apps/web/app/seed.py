from __future__ import annotations

from datetime import date
import re

from sqlalchemy.orm import Session

from .models import Event, MerchItem

SAMPLE_EVENTS = [
    {
        "slug": "Quarto Giro d'Amaro 2026",
        "title": "Quarto Giro d'Amaro 2026",
        "description": "Giro lungo, giro corto e anche medio. Oltrepò Piacentino.",
        "location": "Piozzano (PC)",
        "date": date(2026, 5, 13),
        "hero_quote": "A tutta.",
        "summary": "Giornata di festa dell'Amaro.",
    },
]

CALENDAR_SEED_EVENTS = [
    # NOTE: eventi multi-giorno -> metto la data di PARTENZA/inizio
    (2, 6,  "Atlas Mountain Race (start)"),
    (2, 7,  "Evento inizio stagione"),
    (2, 22, "Granfondo Laigueglia-Lapeirre"),
    (3, 4,  "Trofeo Laigueglia (pro)"),
    (3, 21, "Milano-Sanremo (pro)"),
    (3, 22, "Sanremo-Sanremo / Classicissima amatoriale"),
    (3, 29, "Granfondo di Casteggio"),
    (4, 4,  "We Ride Flanders (sportive)"),
    (4, 5,  "Giro delle Fiandre / Ronde van Vlaanderen (Pasqua)"),
    (4, 11, "Paris-Roubaix Challenge (amat)"),
    (4, 12, "Paris-Roubaix (pro)"),
    (4, 19, "Granfondo Torino"),
    (4, 26, "CINQUE TERRE Granfondo"),
    (4, 30, "The Traka (start)"),
    (5, 9,  "Giro Amaro"),
    (5, 10, "BGY Airport Granfondo"),
    (5, 17, "Bra Bra Fenix"),
    (5, 23, "Hellenic Mountain Race (start)"),
    (5, 24, "Giro d'Italia - Tappa 15 Voghera > Milano"),
    (6, 21, "Sportful Dolomiti Race"),
    (6, 21, "Granfondo Città di Tortona"),
    (7, 24, "Tour de France - Tappa 19 Gap > Alpe d'Huez"),
    (7, 25, "Tour de France - Tappa 20 Le Bourg d'Oisans > Alpe d'Huez"),
    (9, 27, "Granfondo Internazionale Alassio"),
    (10, 4, "Granfondo Tre Valli Varesine"),
    
    # TODO: "MF S. Cristina e Bissone" -> non trovo ancora una data 2026 ufficiale (la pagina ufficiale dice “da confermare”)
]

SAMPLE_MERCH = [
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
    calendar_events = _build_calendar_events(date.today().year)
    for payload in SAMPLE_EVENTS + calendar_events:
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


def _build_calendar_events(year: int) -> list[dict[str, object]]:
    events: list[dict[str, object]] = []
    for month, day, title in CALENDAR_SEED_EVENTS:
        slug = _slugify(f"{title}-{year}-{month:02d}-{day:02d}")
        events.append(
            {
                "slug": slug,
                "title": title,
                "description": None,
                "location": None,
                "date": date(year, month, day),
                "hero_quote": None,
                "summary": None,
            }
        )
    return events


def _slugify(value: str) -> str:
    value = value.lower()
    value = re.sub(r"[^a-z0-9]+", "-", value)
    return value.strip("-")
