"""Contenuti del sito gestiti dal gestionale: foto, album e blog.

- Le foto si caricano da /admin/foto (vedi admin.py): vengono ridimensionate,
  ripulite dai metadati EXIF (posizione GPS compresa) e salvate in
  UPLOAD_PATH/media. Il sito le serve su /media/<nome>.
- Gli articoli del blog si scrivono da /admin/blog con un editor visuale; l'HTML
  viene sempre ripulito (nh3) prima di essere salvato e prima di essere mostrato.
- Le pagine pubbliche sono /foto, /foto/<slug>, /blog, /blog/<slug>.

Le sezioni vuote non si mostrano: niente contenuti di esempio.
"""
from __future__ import annotations

import html as html_lib
import io
import logging
import re
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

import nh3
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.templating import Jinja2Templates
from PIL import Image, ImageOps, UnidentifiedImageError
from sqlalchemy import func
from sqlalchemy.orm import Session

from .config import settings
from .database import get_session
from .models import BlogPost, Photo, PhotoAlbum

logger = logging.getLogger(__name__)

BASE_DIR = Path(__file__).resolve().parent
# Cartella dedicata: in UPLOAD_PATH ci sono anche i documenti dei soci, che non
# devono mai essere raggiungibili da /media.
MEDIA_DIR = (BASE_DIR / settings.uploads_path).resolve() / "media"
MEDIA_DIR.mkdir(parents=True, exist_ok=True)

MAX_PHOTO_BYTES = 15 * 1024 * 1024
LARGE_MAX_SIDE = 1600
THUMB_MAX_SIDE = 720
JPEG_QUALITY = 82
_ALLOWED_FORMATS = {"JPEG", "MPO", "PNG", "WEBP"}
# Solo i nomi generati da save_photo: <32 esadecimali>[_t].jpg|png
_MEDIA_NAME_RE = re.compile(r"^[0-9a-f]{32}(?:_t)?\.(?:jpg|png)$")

router = APIRouter()
_templates: Jinja2Templates | None = None


def init_templates(templates: Jinja2Templates) -> None:
    """main.py passa il suo Jinja2Templates (stessi filtri e globali del sito)."""
    global _templates
    _templates = templates
    templates.env.filters["it_date"] = format_it_date


def _render(request: Request, name: str, context: dict[str, object]) -> HTMLResponse:
    if _templates is None:  # pragma: no cover - configurazione mancante
        raise RuntimeError("content.init_templates() non chiamato")
    public_base = (settings.app_public_url or str(request.base_url)).rstrip("/")
    return _templates.TemplateResponse(
        name,
        {"request": request, "settings": settings, "public_base": public_base, **context},
    )


# ---------------------------------------------------------------------------
# Foto
# ---------------------------------------------------------------------------


class PhotoError(ValueError):
    """Errore leggibile da mostrare nel gestionale."""


def _has_alpha(image: Image.Image) -> bool:
    if image.mode in ("RGBA", "LA"):
        return True
    return image.mode == "P" and "transparency" in image.info


def _write_image(image: Image.Image, max_side: int, path: Path, as_png: bool) -> tuple[int, int]:
    copy = image.copy()
    copy.thumbnail((max_side, max_side), Image.Resampling.LANCZOS)
    # Nessun parametro exif/icc: il file salvato non ha metadati.
    if as_png:
        copy.save(path, format="PNG", optimize=True)
    else:
        copy.save(
            path,
            format="JPEG",
            quality=JPEG_QUALITY,
            optimize=True,
            progressive=True,
        )
    return copy.size


def store_photo_files(data: bytes, original_name: str | None = None) -> dict[str, object]:
    """Salva versione grande + miniatura e restituisce i campi per Photo.

    Solleva PhotoError con un messaggio in italiano se il file non va bene.
    """
    label = original_name or "Il file"
    if not data:
        raise PhotoError(f"{label} è vuoto.")
    if len(data) > MAX_PHOTO_BYTES:
        raise PhotoError(f"{label} supera i 15 MB.")
    try:
        image = Image.open(io.BytesIO(data))
        fmt = image.format
        image.load()
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError) as exc:
        raise PhotoError(
            f"{label} non è un'immagine leggibile (usa JPG, PNG o WEBP)."
        ) from exc
    if fmt not in _ALLOWED_FORMATS:
        raise PhotoError(f"{label}: formato {fmt or 'sconosciuto'} non supportato (usa JPG, PNG o WEBP).")

    # Le foto da telefono sono spesso "ruotate" solo nei metadati.
    image = ImageOps.exif_transpose(image)
    as_png = _has_alpha(image)
    if as_png:
        image = image.convert("RGBA")
    elif image.mode != "RGB":
        image = image.convert("RGB")

    stem = uuid4().hex
    ext = "png" if as_png else "jpg"
    large_name = f"{stem}.{ext}"
    thumb_name = f"{stem}_t.{ext}"
    MEDIA_DIR.mkdir(parents=True, exist_ok=True)
    try:
        width, height = _write_image(image, LARGE_MAX_SIDE, MEDIA_DIR / large_name, as_png)
        _write_image(image, THUMB_MAX_SIDE, MEDIA_DIR / thumb_name, as_png)
    except OSError as exc:
        for name in (large_name, thumb_name):
            (MEDIA_DIR / name).unlink(missing_ok=True)
        logger.exception("Salvataggio foto non riuscito")
        raise PhotoError(f"{label}: salvataggio non riuscito.") from exc

    return {
        "stored_filename": large_name,
        "thumb_filename": thumb_name,
        "original_name": (Path(original_name).name[:255] if original_name else None),
        "width": width,
        "height": height,
    }


def create_photo(
    session: Session,
    data: bytes,
    original_name: str | None = None,
    album_id: int | None = None,
    show_on_home: bool = False,
    source: str = "gallery",
) -> Photo:
    """Salva i file e aggiunge la Photo alla sessione (commit a carico del chiamante)."""
    fields = store_photo_files(data, original_name)
    position_query = session.query(func.max(Photo.position)).filter(Photo.source == source)
    if album_id is None:
        position_query = position_query.filter(Photo.album_id.is_(None))
    else:
        position_query = position_query.filter(Photo.album_id == album_id)
    last_position = position_query.scalar() or 0
    photo = Photo(
        album_id=album_id,
        show_on_home=show_on_home,
        position=last_position + 1,
        source=source,
        **fields,
    )
    session.add(photo)
    session.flush()
    return photo


def delete_photo(session: Session, photo: Photo) -> None:
    """Elimina record e file; toglie la foto da copertine di album e articoli."""
    session.query(PhotoAlbum).filter(PhotoAlbum.cover_photo_id == photo.id).update(
        {PhotoAlbum.cover_photo_id: None}, synchronize_session=False
    )
    session.query(BlogPost).filter(BlogPost.cover_photo_id == photo.id).update(
        {BlogPost.cover_photo_id: None}, synchronize_session=False
    )
    for name in (photo.stored_filename, photo.thumb_filename):
        if name and _MEDIA_NAME_RE.match(name):
            (MEDIA_DIR / name).unlink(missing_ok=True)
    session.delete(photo)


def media_names_in_html(value: str | None) -> set[str]:
    """Nomi dei file /media/... citati nell'HTML di un articolo."""
    if not value:
        return set()
    found = re.findall(r"/media/([0-9a-f]{32}\.(?:jpg|png))", value)
    return {name for name in found if _MEDIA_NAME_RE.match(name)}


def delete_blog_post(session: Session, post: BlogPost) -> None:
    """Elimina l'articolo e le foto caricate apposta (copertina e immagini nel testo)."""
    names = media_names_in_html(post.body_html)
    candidates: list[Photo] = []
    if names:
        candidates = (
            session.query(Photo)
            .filter(Photo.source == "blog", Photo.stored_filename.in_(names))
            .all()
        )
    if post.cover_photo and post.cover_photo.source == "blog":
        candidates.append(post.cover_photo)
    post.cover_photo_id = None
    session.flush()
    seen: set[int] = set()
    for photo in candidates:
        if photo.id in seen:
            continue
        seen.add(photo.id)
        # non toccare foto usate anche da un altro articolo
        others = (
            session.query(BlogPost)
            .filter(BlogPost.id != post.id)
            .filter(
                (BlogPost.cover_photo_id == photo.id)
                | (BlogPost.body_html.contains(photo.stored_filename))
            )
            .count()
        )
        if not others:
            delete_photo(session, photo)
    session.delete(post)


def album_cover(session: Session, album: PhotoAlbum) -> Photo | None:
    if album.cover_photo_id:
        cover = session.get(Photo, album.cover_photo_id)
        if cover and cover.album_id == album.id:
            return cover
    return album.photos[0] if album.photos else None


# ---------------------------------------------------------------------------
# Blog
# ---------------------------------------------------------------------------

_BLOG_TAGS = {
    "p", "br", "strong", "em", "u", "s", "a", "h2", "h3",
    "ul", "ol", "li", "blockquote", "img", "figure", "figcaption",
}
_BLOG_ATTRIBUTES = {"a": {"href", "target"}, "img": {"src", "alt"}}
_BLOG_URL_SCHEMES = {"http", "https", "mailto"}
_EMPTY_PARAGRAPHS_RE = re.compile(r"(?:<p>(?:\s|<br\s*/?>)*</p>\s*)+$")


def sanitize_blog_html(value: str | None) -> str:
    """Tiene solo la formattazione dell'editor; via script, stili, iframe, data: URI."""
    if not value:
        return ""
    cleaned = nh3.clean(
        value,
        tags=_BLOG_TAGS,
        attributes=_BLOG_ATTRIBUTES,
        url_schemes=_BLOG_URL_SCHEMES,
        link_rel="noopener noreferrer",
    )
    # immagini rimaste senza src (es. incollate come data: URI) non servono
    cleaned = re.sub(r"<img(?![^>]*\bsrc=)[^>]*>", "", cleaned)
    return _EMPTY_PARAGRAPHS_RE.sub("", cleaned).strip()


def html_to_text(value: str | None) -> str:
    if not value:
        return ""
    with_breaks = re.sub(r"</(p|h2|h3|li|blockquote)>", " ", value)
    text = nh3.clean(with_breaks, tags=set())
    return re.sub(r"\s+", " ", html_lib.unescape(text)).strip()


def make_excerpt(body_html: str | None, limit: int = 220) -> str:
    text = html_to_text(body_html)
    if len(text) <= limit:
        return text
    cut = text[:limit].rsplit(" ", 1)[0].rstrip(",;:.- ")
    return f"{cut}…"


def post_excerpt(post: BlogPost) -> str:
    return (post.excerpt or "").strip() or make_excerpt(post.body_html)


def published_posts_query(session: Session):
    return (
        session.query(BlogPost)
        .filter(BlogPost.is_published.is_(True))
        .order_by(BlogPost.published_at.desc(), BlogPost.id.desc())
    )


def latest_posts(session: Session, limit: int = 3) -> list[BlogPost]:
    return published_posts_query(session).limit(limit).all()


def home_photos(session: Session, limit: int = 8) -> list[Photo]:
    """Foto con "In home", escluse quelle di album non pubblicati."""
    return (
        session.query(Photo)
        .outerjoin(PhotoAlbum, Photo.album_id == PhotoAlbum.id)
        .filter(Photo.show_on_home.is_(True), Photo.source == "gallery")
        .filter((Photo.album_id.is_(None)) | (PhotoAlbum.is_published.is_(True)))
        .order_by(Photo.created_at.desc(), Photo.id.desc())
        .limit(limit)
        .all()
    )


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def format_it_date(value: object) -> str:
    if not value:
        return ""
    months = [
        "gennaio", "febbraio", "marzo", "aprile", "maggio", "giugno",
        "luglio", "agosto", "settembre", "ottobre", "novembre", "dicembre",
    ]
    return f"{value.day} {months[value.month - 1]} {value.year}"


def render_blog_post(request: Request, post: BlogPost, preview: bool = False) -> HTMLResponse:
    return _render(
        request,
        "blog_post.html",
        {
            "post": post,
            "body_html": sanitize_blog_html(post.body_html),
            "excerpt": post_excerpt(post),
            "preview": preview,
        },
    )


# ---------------------------------------------------------------------------
# Rotte pubbliche
# ---------------------------------------------------------------------------


@router.get("/media/{name}", include_in_schema=False)
def media_file(name: str) -> FileResponse:
    if not _MEDIA_NAME_RE.match(name):
        raise HTTPException(status_code=404)
    path = MEDIA_DIR / name
    if not path.is_file():
        raise HTTPException(status_code=404)
    media_type = "image/png" if name.endswith(".png") else "image/jpeg"
    # nomi casuali e mai riusati: si può mettere in cache per sempre
    return FileResponse(
        path,
        media_type=media_type,
        headers={"Cache-Control": "public, max-age=31536000, immutable"},
    )


@router.get("/foto", response_class=HTMLResponse)
def photo_albums_page(request: Request, session: Session = Depends(get_session)) -> HTMLResponse:
    albums = (
        session.query(PhotoAlbum)
        .filter(PhotoAlbum.is_published.is_(True))
        .order_by(PhotoAlbum.date.is_(None), PhotoAlbum.date.desc(), PhotoAlbum.id.desc())
        .all()
    )
    cards = []
    for album in albums:
        if not album.photos:
            continue
        cards.append(
            {
                "album": album,
                "cover": album_cover(session, album),
                "count": len(album.photos),
            }
        )
    return _render(request, "photos.html", {"albums": cards})


@router.get("/foto/{slug}", response_class=HTMLResponse)
def photo_album_page(
    slug: str, request: Request, session: Session = Depends(get_session)
) -> HTMLResponse:
    album = (
        session.query(PhotoAlbum)
        .filter(PhotoAlbum.slug == slug, PhotoAlbum.is_published.is_(True))
        .first()
    )
    if not album or not album.photos:
        raise HTTPException(status_code=404, detail="Album non trovato")
    return _render(
        request,
        "photo_album.html",
        {"album": album, "cover": album_cover(session, album)},
    )


@router.get("/blog", response_class=HTMLResponse)
def blog_index(request: Request, session: Session = Depends(get_session)) -> HTMLResponse:
    posts = published_posts_query(session).all()
    return _render(
        request,
        "blog.html",
        {"posts": [{"post": p, "excerpt": post_excerpt(p)} for p in posts]},
    )


@router.get("/blog/{slug}", response_class=HTMLResponse)
def blog_post_page(
    slug: str, request: Request, session: Session = Depends(get_session)
) -> HTMLResponse:
    post = (
        session.query(BlogPost)
        .filter(BlogPost.slug == slug, BlogPost.is_published.is_(True))
        .first()
    )
    if not post:
        raise HTTPException(status_code=404, detail="Articolo non trovato")
    return render_blog_post(request, post)
