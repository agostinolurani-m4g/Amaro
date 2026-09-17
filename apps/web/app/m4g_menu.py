"""Menu bar e cucina evento Move for Gaza."""

BAR_MENU: list[dict[str, object]] = [
    {
        "category": "Pranzo — Cucina Franca",
        "vendor_id": "cucina-franca",
        "items": [
            {"id": "primo-giorno", "name": "Primo del giorno", "price_cents": 800},
            {"id": "secondo-giorno", "name": "Secondo del giorno", "price_cents": 900},
            {"id": "contorno", "name": "Contorno", "price_cents": 400},
        ],
    },
    {
        "category": "Pranzo — Tondo Forno Radicale",
        "vendor_id": "tondo-forno",
        "items": [
            {"id": "pizza-taglio", "name": "Pizza al taglio", "price_cents": 450},
            {"id": "focaccia", "name": "Focaccia", "price_cents": 400},
        ],
    },
    {
        "category": "Birra",
        "items": [
            {"id": "birra-piccola", "name": "Birra piccola", "price_cents": 400},
            {"id": "birra-media", "name": "Birra media", "price_cents": 500},
            {"id": "birra-grande", "name": "Birra grande", "price_cents": 600},
            {"id": "birra-speciale", "name": "Birra speciale", "price_cents": 700},
        ],
    },
    {
        "category": "Snack bar",
        "items": [
            {"id": "panino", "name": "Panino", "price_cents": 600},
            {"id": "piadina", "name": "Piadina", "price_cents": 550},
            {"id": "patatine", "name": "Patatine", "price_cents": 400},
            {"id": "dolce", "name": "Dolce", "price_cents": 350},
        ],
    },
    {
        "category": "Bevande",
        "items": [
            {"id": "acqua", "name": "Acqua", "price_cents": 200},
            {"id": "bibita", "name": "Bibita", "price_cents": 300},
            {"id": "caffe", "name": "Caffè", "price_cents": 150},
        ],
    },
]

MENU_BY_ID: dict[str, dict[str, object]] = {
    str(item["id"]): item
    for section in BAR_MENU
    for item in section["items"]  # type: ignore[index]
}
