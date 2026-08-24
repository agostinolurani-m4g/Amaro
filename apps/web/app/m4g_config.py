"""Configurazione evento Move for Gaza (separata dal sito Amaro)."""

from __future__ import annotations

M4G_EVENT = {
    "title": "Move for Gaza",
    "tagline": "Pedala, gioca, corri — insieme per Gaza",
    "date": "18 ottobre 2025",
    "location": "Arci Olmi, via degli Ulivi 2, Milano",
    "contact_email": "amaro.bici@gmail.com",
    "public_site": "https://www.move-4-gaza.com",
    "logo_url": "https://www.move-4-gaza.com/M4G-mix.svg",
    "beneficiary_name": "Gaza Sunbirds",
    "beneficiary_url": "https://gazasunbirds.org/",
    "limits": {
        "soccer_teams_max": 12,
        "run_max": 100,
    },
    "pricing": {
        "person_cents": 1500,
        "soccer_team_cents": 7500,
    },
    "descrizione_evento": (
        "L'evento si divide in due momenti principali: la mattina manifestazioni sportive "
        "non competitive (calcio a 5, corsa 7 km, giro ciclistico) presso l'Arci Olmi. "
        "Dopo il pranzo sociale (verso le 14:00) momenti di approfondimento con ospiti "
        "e testimonianze dalla Palestina."
    ),
    "descrizione_bici": (
        "Percorso lungo ~115 km che ricalca il perimetro della Striscia di Gaza, "
        "partenza e arrivo all'Arci Olmi. Evento sociale e solidale, non competitivo."
    ),
    "descrizione_calcio": (
        "Torneo di calcio a 5 non competitivo, squadre miste. "
        "Donazione minima 75 € a squadra (15 € a persona). Torneo 9:30–13:00."
    ),
    "descrizione_corsa": (
        "Corsa non competitiva ~7 km, staffetta 7+7 o 14 km in solitaria. "
        "Donazione minima 15 €. Partenza ore 11:00."
    ),
    "descrizione_ingresso": (
        "Ingresso per chi partecipa senza attività sportiva: pranzo, tifo e talk. "
        "Donazione minima 15 €."
    ),
    "cause": (
        "Pedaliamo, giochiamo e corriamo per raccogliere fondi destinati ad aiuti "
        "umanitari a Gaza tramite Gaza Sunbirds."
    ),
    "bike_distances": [
        {"key": "112", "label": "112 km — Perimetro di Gaza in scala reale"},
        {"key": "20", "label": "25 km — percorso cittadino"},
    ],
    "gpx": {
        "bike_112": "https://www.move-4-gaza.com/routes/rideforgaza112.gpx",
        "bike_20": "https://www.move-4-gaza.com/routes/amgaz_bici_short.gpx",
        "run": "https://www.move-4-gaza.com/routes/amgaz_corsa.gpx",
    },
}

ACTIVITIES = [
    {
        "key": "bike",
        "title": "Ride4Gaza",
        "subtitle": "Giro ciclistico solidale",
        "path": "/m4g/bici",
        "price_label": "15 €",
    },
    {
        "key": "soccer",
        "title": "Play4Gaza",
        "subtitle": "Torneo calcio a 5",
        "path": "/m4g/calcio",
        "price_label": "75 € / squadra",
    },
    {
        "key": "run",
        "title": "Run4Gaza",
        "subtitle": "Corsa o staffetta",
        "path": "/m4g/corsa",
        "price_label": "15 €",
    },
    {
        "key": "entrance",
        "title": "Support4Gaza",
        "subtitle": "Ingresso senza sport",
        "path": "/m4g/ingresso",
        "price_label": "15 €",
    },
]
