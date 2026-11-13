"""Foto, blog e uscite soci: helper, pagine pubbliche, gestionale, area tesserati."""
from __future__ import annotations

import io
import os
import tempfile

import _no_real_email  # noqa: F401,E402  (prima di app.*)
import unittest
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from unittest import mock
from uuid import uuid4

os.environ.setdefault("NEXI_ENDPOINT", "https://example.test/nexi")
os.environ.setdefault("NEXI_SUCCESS_URL", "https://example.test/success")
os.environ.setdefault("NEXI_FAILURE_URL", "https://example.test/failure")
os.environ.setdefault("SESSION_SECRET", "test-content-secret")
os.environ.setdefault("M4G_SITE_PASSWORD", "test-m4g-password")

from fastapi import FastAPI  # noqa: E402
from fastapi.staticfiles import StaticFiles  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from PIL import Image  # noqa: E402
from starlette.middleware.sessions import SessionMiddleware  # noqa: E402

from app import admin as admin_module  # noqa: E402
from app import content, main  # noqa: E402
from app.config import settings  # noqa: E402
from app.database import Base, SessionLocal, engine  # noqa: E402
from app.models import BlogPost, Member, MemberRide, Photo, PhotoAlbum  # noqa: E402


def _jpeg_bytes(size: tuple[int, int] = (3000, 2000), orientation: int | None = None) -> bytes:
    image = Image.new("RGB", size, (200, 30, 90))
    exif = Image.Exif()
    exif[0x010F] = "FotocameraDiProva"  # Make
    exif[0x0132] = "2026:05:01 10:00:00"  # DateTime
    if orientation:
        exif[0x0112] = orientation
    buffer = io.BytesIO()
    image.save(buffer, format="JPEG", exif=exif.tobytes())
    return buffer.getvalue()


def _png_with_alpha() -> bytes:
    buffer = io.BytesIO()
    Image.new("RGBA", (400, 300), (0, 0, 0, 0)).save(buffer, format="PNG")
    return buffer.getvalue()


class _TempMediaMixin:
    def _use_temp_media(self) -> Path:
        self._media_tmp = tempfile.TemporaryDirectory()
        media_dir = Path(self._media_tmp.name)
        self._media_patch = mock.patch.object(content, "MEDIA_DIR", media_dir)
        self._media_patch.start()
        return media_dir

    def _drop_temp_media(self) -> None:
        self._media_patch.stop()
        self._media_tmp.cleanup()


class SanitizeTests(unittest.TestCase):
    def test_keeps_editor_formatting(self) -> None:
        html = (
            '<h2>Titolo</h2><p><strong>forte</strong> <em>corsivo</em> '
            '<a href="https://example.test/x">link</a></p>'
            '<ul><li>uno</li></ul><img src="/media/abc.jpg" alt="foto">'
        )
        cleaned = content.sanitize_blog_html(html)
        for fragment in ("<h2>Titolo</h2>", "<strong>forte</strong>", "<em>corsivo</em>",
                         "<li>uno</li>", 'src="/media/abc.jpg"'):
            self.assertIn(fragment, cleaned)
        self.assertIn('rel="noopener noreferrer"', cleaned)

    def test_removes_dangerous_markup(self) -> None:
        html = (
            '<p onclick="alert(1)">ciao</p><script>alert(2)</script>'
            '<a href="javascript:alert(3)">x</a><iframe src="https://evil.test"></iframe>'
            '<img src="data:image/png;base64,AAAA"><p style="color:red">rosso</p>'
        )
        cleaned = content.sanitize_blog_html(html)
        for bad in ("onclick", "<script", "alert(2)", "javascript:", "<iframe", "data:", "style="):
            self.assertNotIn(bad, cleaned)
        self.assertNotIn("<img", cleaned)
        self.assertIn("<p>ciao</p>", cleaned)
        self.assertIn("rosso", cleaned)

    def test_trailing_empty_paragraphs_removed(self) -> None:
        self.assertEqual(content.sanitize_blog_html("<p>a</p><p><br></p><p></p>"), "<p>a</p>")

    def test_excerpt_from_body(self) -> None:
        body = "<h2>Giro</h2><p>Siamo partiti &amp; arrivati.</p>" + "<p>" + "parola " * 80 + "</p>"
        excerpt = content.make_excerpt(body, limit=60)
        self.assertTrue(excerpt.startswith("Giro Siamo partiti & arrivati."))
        self.assertTrue(excerpt.endswith("…"))
        self.assertLessEqual(len(excerpt), 61)


class PhotoStorageTests(_TempMediaMixin, unittest.TestCase):
    def setUp(self) -> None:
        self.media_dir = self._use_temp_media()

    def tearDown(self) -> None:
        self._drop_temp_media()

    def test_resizes_rotates_and_strips_metadata(self) -> None:
        fields = content.store_photo_files(_jpeg_bytes(orientation=6), "IMG_0001.JPG")
        with Image.open(self.media_dir / fields["stored_filename"]) as large, Image.open(
            self.media_dir / fields["thumb_filename"]
        ) as thumb:
            # orientamento 6 = ruotata di 90°: diventa verticale
            self.assertEqual(large.size, (1067, 1600))
            self.assertEqual((fields["width"], fields["height"]), large.size)
            self.assertLessEqual(max(thumb.size), content.THUMB_MAX_SIDE)
            for image in (large, thumb):
                self.assertEqual(image.format, "JPEG")
                self.assertEqual(len(image.getexif()), 0)
                self.assertNotIn("exif", image.info)
        self.assertEqual(fields["original_name"], "IMG_0001.JPG")

    def test_png_with_transparency_stays_png(self) -> None:
        fields = content.store_photo_files(_png_with_alpha(), "logo.png")
        self.assertTrue(fields["stored_filename"].endswith(".png"))
        with Image.open(self.media_dir / fields["stored_filename"]) as image:
            self.assertEqual(image.mode, "RGBA")

    def test_rejects_non_images_and_big_files(self) -> None:
        with self.assertRaises(content.PhotoError):
            content.store_photo_files(b"%PDF-1.4 non una foto", "doc.pdf")
        with self.assertRaises(content.PhotoError):
            content.store_photo_files(b"", "vuota.jpg")
        with mock.patch.object(content, "MAX_PHOTO_BYTES", 10):
            with self.assertRaises(content.PhotoError):
                content.store_photo_files(_jpeg_bytes((50, 50)), "grande.jpg")
        self.assertEqual(list(self.media_dir.iterdir()), [])


class MediaRouteTests(_TempMediaMixin, unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._client = TestClient(main.app)
        cls.client = cls._client.__enter__()

    @classmethod
    def tearDownClass(cls) -> None:
        cls._client.__exit__(None, None, None)

    def setUp(self) -> None:
        self.media_dir = self._use_temp_media()

    def tearDown(self) -> None:
        self._drop_temp_media()

    def test_serves_only_generated_names(self) -> None:
        fields = content.store_photo_files(_jpeg_bytes((100, 80)))
        response = self.client.get(f"/media/{fields['stored_filename']}")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["content-type"], "image/jpeg")
        self.assertIn("immutable", response.headers["cache-control"])

        (self.media_dir / "documento.pdf").write_bytes(b"segreto")
        for name in ("documento.pdf", "..%2Famaro.db", "%2E%2E%2Fsecret", f"{'0' * 32}.jpg"):
            self.assertEqual(self.client.get(f"/media/{name}").status_code, 404, name)

    def test_member_documents_are_not_reachable(self) -> None:
        # i documenti dei soci stanno in UPLOAD_PATH, non in UPLOAD_PATH/media
        self.assertNotEqual(content.MEDIA_DIR, main.UPLOADS_DIR)
        self.assertEqual(self.client.get("/media/").status_code, 404)


class PublicPagesTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._client = TestClient(main.app)
        cls.client = cls._client.__enter__()

    @classmethod
    def tearDownClass(cls) -> None:
        cls._client.__exit__(None, None, None)

    def setUp(self) -> None:
        self.tag = uuid4().hex[:8]
        self.session = SessionLocal()
        self.photo_files: list[str] = []

    def tearDown(self) -> None:
        self.session.rollback()
        self.session.query(BlogPost).filter(BlogPost.slug.like(f"%{self.tag}%")).delete(
            synchronize_session=False
        )
        albums = self.session.query(PhotoAlbum).filter(PhotoAlbum.slug.like(f"%{self.tag}%")).all()
        for album in albums:
            for photo in album.photos:
                self.session.delete(photo)
            self.session.delete(album)
        self.session.commit()
        self.session.close()

    def _post(self, published: bool, **extra) -> BlogPost:
        post = BlogPost(
            title=f"Articolo {self.tag} {'pub' if published else 'bozza'}",
            slug=f"articolo-{self.tag}-{'pub' if published else 'bozza'}",
            body_html="<p>Testo del giro <strong>bello</strong>.</p><script>alert(1)</script>",
            is_published=published,
            published_at=datetime.now(timezone.utc) if published else None,
            **extra,
        )
        self.session.add(post)
        self.session.commit()
        return post

    def _album(self, published: bool) -> PhotoAlbum:
        album = PhotoAlbum(
            title=f"Album {self.tag}",
            slug=f"album-{self.tag}-{int(published)}",
            is_published=published,
            date=date(2026, 5, 1),
        )
        self.session.add(album)
        self.session.flush()
        self.session.add(
            Photo(
                album_id=album.id,
                stored_filename=f"{uuid4().hex}.jpg",
                thumb_filename=f"{uuid4().hex}_t.jpg",
                caption=f"Didascalia {self.tag}",
                width=1600,
                height=1067,
            )
        )
        self.session.commit()
        return album

    def test_blog_shows_only_published_posts(self) -> None:
        published = self._post(True)
        draft = self._post(False)

        index = self.client.get("/blog")
        self.assertEqual(index.status_code, 200)
        self.assertIn(published.title, index.text)
        self.assertNotIn(draft.title, index.text)

        page = self.client.get(f"/blog/{published.slug}")
        self.assertEqual(page.status_code, 200)
        self.assertIn("<strong>bello</strong>", page.text)
        self.assertNotIn("alert(1)", page.text)

        self.assertEqual(self.client.get(f"/blog/{draft.slug}").status_code, 404)

    def test_home_lists_latest_posts(self) -> None:
        published = self._post(True)
        home = self.client.get("/")
        self.assertEqual(home.status_code, 200)
        self.assertIn(published.title, home.text)
        self.assertIn(f"/blog/{published.slug}", home.text)

    def test_home_hides_empty_sections(self) -> None:
        with mock.patch.object(content, "latest_posts", return_value=[]), mock.patch.object(
            content, "home_photos", return_value=[]
        ):
            home = self.client.get("/")
        self.assertEqual(home.status_code, 200)
        self.assertNotIn('id="blog"', home.text)
        self.assertNotIn('id="foto"', home.text)
        # le voci di menu ci sono comunque
        self.assertIn('href="/blog"', home.text)
        self.assertIn('href="/foto"', home.text)

    def test_albums_published_only(self) -> None:
        visible = self._album(True)
        hidden = self._album(False)
        index = self.client.get("/foto")
        self.assertEqual(index.status_code, 200)
        self.assertIn(f"/foto/{visible.slug}", index.text)
        self.assertNotIn(f"/foto/{hidden.slug}", index.text)

        page = self.client.get(f"/foto/{visible.slug}")
        self.assertEqual(page.status_code, 200)
        self.assertIn(f"Didascalia {self.tag}", page.text)
        self.assertIn("data-lightbox", page.text)
        self.assertEqual(self.client.get(f"/foto/{hidden.slug}").status_code, 404)


class AdminContentTests(_TempMediaMixin, unittest.TestCase):
    """Gestionale su un'app di prova: in CI ADMIN_USERNAME/PASSWORD non ci sono."""

    @classmethod
    def setUpClass(cls) -> None:
        # l'app di prova non ha lo startup di main: tabelle create qui (DB vuoto in CI)
        Base.metadata.create_all(bind=engine)

    def setUp(self) -> None:
        self.media_dir = self._use_temp_media()
        self._patches = [
            mock.patch.object(settings, "admin_username", "admin-test"),
            mock.patch.object(settings, "admin_password", "password-test"),
        ]
        for patch in self._patches:
            patch.start()
        app = FastAPI()
        app.add_middleware(SessionMiddleware, secret_key="test", session_cookie="amaro_session")
        app.mount("/static", StaticFiles(directory=main.static_dir), name="static")
        app.include_router(content.router)
        admin_module.setup_admin(app)
        self.client = TestClient(app)
        self.tag = uuid4().hex[:8]

    def tearDown(self) -> None:
        session = SessionLocal()
        for post in session.query(BlogPost).filter(BlogPost.title.like(f"%{self.tag}%")).all():
            content.delete_blog_post(session, post)
        for album in session.query(PhotoAlbum).filter(PhotoAlbum.title.like(f"%{self.tag}%")).all():
            for photo in list(album.photos):
                content.delete_photo(session, photo)
            session.delete(album)
        session.commit()
        session.close()
        for patch in self._patches:
            patch.stop()
        self._drop_temp_media()

    def _login(self) -> None:
        response = self.client.post(
            "/admin/login",
            data={"username": "admin-test", "password": "password-test"},
            follow_redirects=False,
        )
        self.assertIn(response.status_code, (302, 303))

    def test_requires_login(self) -> None:
        for path in ("/admin/foto", "/admin/blog", "/admin/blog/nuovo"):
            response = self.client.get(path, follow_redirects=False)
            self.assertIn(response.status_code, (302, 303), path)
            self.assertIn("/admin/login", response.headers["location"])
        response = self.client.post(
            "/admin/foto",
            data={"action": "upload", "album_choice": "new", "new_album_title": "x"},
            files=[("files", ("a.jpg", _jpeg_bytes((80, 60)), "image/jpeg"))],
            follow_redirects=False,
        )
        self.assertIn(response.status_code, (302, 303))
        self.assertEqual(list(self.media_dir.iterdir()), [])

    def test_upload_photos_into_new_album(self) -> None:
        self._login()
        self.assertEqual(self.client.get("/admin/foto").status_code, 200)
        response = self.client.post(
            "/admin/foto",
            data={
                "action": "upload",
                "album_choice": "new",
                "new_album_title": f"Uscita {self.tag}",
                "new_album_date": "2026-05-01",
                "show_on_home": "1",
            },
            files=[
                ("files", ("uno.jpg", _jpeg_bytes(), "image/jpeg")),
                ("files", ("due.jpg", _jpeg_bytes((800, 600)), "image/jpeg")),
                ("files", ("nota.txt", b"non sono una foto", "text/plain")),
            ],
            follow_redirects=False,
        )
        self.assertEqual(response.status_code, 303)
        self.assertIn("album=", response.headers["location"])

        session = SessionLocal()
        try:
            album = session.query(PhotoAlbum).filter(PhotoAlbum.title == f"Uscita {self.tag}").one()
            self.assertEqual(album.slug, f"uscita-{self.tag}")
            self.assertEqual(album.date, date(2026, 5, 1))
            self.assertEqual(len(album.photos), 2)
            self.assertTrue(all(p.show_on_home for p in album.photos))
            names = {p.stored_filename for p in album.photos} | {p.thumb_filename for p in album.photos}
            self.assertEqual({f.name for f in self.media_dir.iterdir()}, names)
            first, second = album.photos
        finally:
            session.close()

        page = self.client.get(response.headers["location"])
        self.assertEqual(page.status_code, 200)
        self.assertIn("Caricate 2 foto", page.text)
        self.assertIn("non è un&#39;immagine leggibile", page.text)

        # salva: didascalia, copertina, elimina una foto
        response = self.client.post(
            "/admin/foto",
            data={
                "action": "save_album",
                "album_id": str(album.id),
                "title": f"Uscita {self.tag}",
                "is_published": "1",
                f"caption_{first.id}": "In salita",
                "cover_photo_id": str(first.id),
                f"delete_{second.id}": "1",
            },
            follow_redirects=False,
        )
        self.assertEqual(response.status_code, 303)
        session = SessionLocal()
        try:
            album = session.get(PhotoAlbum, album.id)
            self.assertEqual([p.id for p in album.photos], [first.id])
            self.assertEqual(album.photos[0].caption, "In salita")
            self.assertFalse(album.photos[0].show_on_home)
            self.assertEqual(album.cover_photo_id, first.id)
        finally:
            session.close()
        self.assertFalse((self.media_dir / second.stored_filename).exists())

    def test_blog_create_sanitize_preview_publish(self) -> None:
        self._login()
        response = self.client.post(
            "/admin/blog/nuovo",
            data={
                "title": f"Perché pedaliamo {self.tag}",
                "body_html": "<p>Ciao <strong>soci</strong></p><script>alert(1)</script>",
                "after": "preview",
            },
            files=[("cover", ("copertina.jpg", _jpeg_bytes((1200, 800)), "image/jpeg"))],
            follow_redirects=False,
        )
        self.assertEqual(response.status_code, 303)
        self.assertTrue(response.headers["location"].endswith("/anteprima"))

        session = SessionLocal()
        try:
            post = session.query(BlogPost).filter(BlogPost.title.like(f"%{self.tag}%")).one()
            self.assertEqual(post.slug, f"perche-pedaliamo-{self.tag}")
            self.assertFalse(post.is_published)
            self.assertNotIn("script", post.body_html)
            self.assertEqual(post.cover_photo.source, "blog")
            post_id, slug = post.id, post.slug
        finally:
            session.close()

        preview = self.client.get(response.headers["location"])
        self.assertEqual(preview.status_code, 200)
        self.assertIn("bozza", preview.text)
        self.assertIn("<strong>soci</strong>", preview.text)

        # immagine dal pulsante dell'editor
        upload = self.client.post(
            "/admin/blog/immagine",
            files=[("file", ("dentro.jpg", _jpeg_bytes((900, 600)), "image/jpeg"))],
        )
        self.assertEqual(upload.status_code, 200)
        image_url = upload.json()["url"]
        self.assertRegex(image_url, r"^/media/[0-9a-f]{32}\.jpg$")
        bad = self.client.post(
            "/admin/blog/immagine", files=[("file", ("x.txt", b"no", "text/plain"))]
        )
        self.assertEqual(bad.status_code, 400)
        self.assertIn("error", bad.json())

        response = self.client.post(
            f"/admin/blog/{post_id}",
            data={
                "title": f"Perché pedaliamo {self.tag}",
                "body_html": f'<p>Ciao <strong>soci</strong></p><p><img src="{image_url}"></p>',
                "is_published": "1",
                "after": "edit",
            },
            follow_redirects=False,
        )
        self.assertEqual(response.status_code, 303)
        session = SessionLocal()
        try:
            post = session.get(BlogPost, post_id)
            self.assertTrue(post.is_published)
            self.assertIsNotNone(post.published_at)
            self.assertIsNotNone(post.cover_photo_id)
        finally:
            session.close()
        self.assertEqual(self.client.get(f"/blog/{slug}").status_code, 200)

        # eliminando l'articolo spariscono anche copertina e immagini caricate per lui
        self.assertEqual(len(list(self.media_dir.iterdir())), 4)
        response = self.client.post(f"/admin/blog/{post_id}/elimina", follow_redirects=False)
        self.assertEqual(response.status_code, 303)
        self.assertEqual(list(self.media_dir.iterdir()), [])
        self.assertEqual(self.client.get(f"/blog/{slug}").status_code, 404)

    def test_cannot_publish_empty_post(self) -> None:
        self._login()
        response = self.client.post(
            "/admin/blog/nuovo",
            data={"title": f"Vuoto {self.tag}", "body_html": "<p><br></p>", "is_published": "1"},
        )
        self.assertEqual(response.status_code, 200)
        self.assertIn("articolo vuoto", response.text)


class MemberRidesTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._client = TestClient(main.app)
        cls._client.__enter__()

    @classmethod
    def tearDownClass(cls) -> None:
        cls._client.__exit__(None, None, None)

    def setUp(self) -> None:
        self.tag = uuid4().hex[:8]
        session = SessionLocal()
        today = date.today()
        session.add_all(
            [
                MemberRide(title=f"Futura {self.tag}", date=today + timedelta(days=3),
                           start_time="08:30", meeting_point="Piazza", distance_km=80,
                           elevation_m=900, notes="Portare la mantellina"),
                MemberRide(title=f"Passata {self.tag}", date=today - timedelta(days=3)),
            ]
        )
        self.member_ids: list[int] = []
        for status in ("paid", "pending"):
            member = Member(
                name="Socio Prova", first_name="Socio", last_name="Prova",
                email=f"{status}-{self.tag}@example.test", membership_type="Socio ordinario",
                payment_status=status, password_hash=main._hash_password("segreta"),
            )
            session.add(member)
            session.flush()
            self.member_ids.append(member.id)
        session.commit()
        session.close()

    def tearDown(self) -> None:
        session = SessionLocal()
        session.query(MemberRide).filter(MemberRide.title.like(f"%{self.tag}%")).delete(
            synchronize_session=False
        )
        session.query(Member).filter(Member.id.in_(self.member_ids)).delete(
            synchronize_session=False
        )
        session.commit()
        session.close()

    def _login(self, status: str) -> TestClient:
        client = TestClient(main.app)
        client.post(
            "/area-tesserati/login",
            data={"email": f"{status}-{self.tag}@example.test", "password": "segreta"},
        )
        return client

    def test_paid_member_sees_upcoming_rides_only(self) -> None:
        page = self._login("paid").get("/area-tesserati")
        self.assertEqual(page.status_code, 200)
        self.assertIn('id="uscite"', page.text)
        self.assertIn(f"Futura {self.tag}", page.text)
        self.assertIn("ore 08:30", page.text)
        self.assertIn("80 km", page.text)
        self.assertNotIn(f"Passata {self.tag}", page.text)

    def test_hidden_to_unpaid_members_and_visitors(self) -> None:
        unpaid = self._login("pending").get("/area-tesserati")
        self.assertEqual(unpaid.status_code, 200)
        self.assertNotIn(f"Futura {self.tag}", unpaid.text)
        anonymous = TestClient(main.app).get("/area-tesserati")
        self.assertNotIn(f"Futura {self.tag}", anonymous.text)


if __name__ == "__main__":
    unittest.main()
