from __future__ import annotations

import io
import os
import unittest
from datetime import date, timedelta
from unittest import mock

os.environ.setdefault("NEXI_ENDPOINT", "https://example.test/nexi")
os.environ.setdefault("NEXI_SUCCESS_URL", "https://example.test/nexi/success")
os.environ.setdefault("NEXI_FAILURE_URL", "https://example.test/nexi/failure")
os.environ.setdefault("SESSION_SECRET", "test-review-secret")
os.environ.setdefault("M4G_SITE_PASSWORD", "test-m4g-password")

from fastapi.testclient import TestClient  # noqa: E402

from app import acsi, main  # noqa: E402
from app.config import Settings, settings  # noqa: E402
from app.database import SessionLocal  # noqa: E402
from app.models import Member, MemberDocument, MembershipPayment  # noqa: E402


class _FakeSMTP:
    sent: list = []

    def __init__(self, *args, **kwargs) -> None:
        pass

    def starttls(self) -> None:
        pass

    def login(self, *args) -> None:
        pass

    def send_message(self, message) -> None:
        _FakeSMTP.sent.append(message)

    def quit(self) -> None:
        pass


class ManualReviewEmailTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._client = TestClient(main.app)
        cls.client = cls._client.__enter__()

    @classmethod
    def tearDownClass(cls) -> None:
        cls._client.__exit__(None, None, None)

    def setUp(self) -> None:
        _FakeSMTP.sent = []
        self._patches = [
            mock.patch.object(settings, "smtp_host", "smtp.example.test"),
            mock.patch.object(settings, "smtp_from", "noreply@example.test"),
            mock.patch.object(settings, "smtp_use_ssl", False),
            mock.patch.object(settings, "smtp_use_tls", False),
            mock.patch.object(acsi.smtplib, "SMTP", _FakeSMTP),
            # niente OCR/email reali durante l'invio del modulo
            mock.patch.object(main, "schedule_documents_ocr"),
            mock.patch.object(main, "_smtp_send_transactional", return_value=True),
        ]
        for patch in self._patches:
            patch.start()
        self.member_ids: list[int] = []
        self.files: list = []
        self.refs: list[str] = []

    def tearDown(self) -> None:
        for patch in self._patches:
            patch.stop()
        session = SessionLocal()
        for member_id in self.member_ids:
            member = session.get(Member, member_id)
            if member:
                for document in member.documents:
                    (acsi.UPLOADS_DIR / document.stored_filename).unlink(missing_ok=True)
                session.delete(member)
        session.query(MembershipPayment).filter(
            MembershipPayment.reference.in_(self.refs)
        ).delete(synchronize_session=False)
        session.commit()
        session.close()

    def _member_with_docs(self, sizes: dict[str, int]) -> int:
        session = SessionLocal()
        member = Member(
            name="Maria Prova", first_name="Maria", last_name="Prova",
            email="maria@example.test", membership_type="Socio ordinario",
            sport_type=main.SPORT_TYPES[0], payment_status="paid",
        )
        session.add(member)
        session.flush()
        for name, size in sizes.items():
            stored = f"test_review_{member.id}_{name}"
            (acsi.UPLOADS_DIR / stored).write_bytes(b"x" * size)
            session.add(
                MemberDocument(
                    member_id=member.id, document_category="Documento",
                    original_name=name, stored_filename=stored,
                    ocr_status="done", ocr_valid=False,
                )
            )
        session.commit()
        self.member_ids.append(member.id)
        member_id = member.id
        session.close()
        return member_id

    def test_default_recipient_is_amaro_gmail(self) -> None:
        self.assertEqual(
            Settings.__fields__["medical_manual_review_email"].default,
            "amaro.bici@gmail.com",
        )

    def test_email_contains_all_documents(self) -> None:
        member_id = self._member_with_docs({"ci.pdf": 10, "ts.jpg": 10, "cm.pdf": 10})
        acsi.send_member_documents_for_manual_review(member_id, [])
        self.assertEqual(len(_FakeSMTP.sent), 1)
        message = _FakeSMTP.sent[0]
        self.assertEqual(message["To"], settings.medical_manual_review_email)
        self.assertEqual(message["Reply-To"], "maria@example.test")
        names = sorted(part.get_filename() for part in message.iter_attachments())
        self.assertEqual(names, ["ci.pdf", "cm.pdf", "ts.jpg"])

    def test_oversized_files_are_listed_not_attached(self) -> None:
        big = acsi.MANUAL_REVIEW_ATTACHMENTS_MAX_BYTES + 1
        member_id = self._member_with_docs({"piccolo.pdf": 10, "enorme.pdf": big})
        acsi.send_member_documents_for_manual_review(member_id, [])
        message = _FakeSMTP.sent[0]
        names = [part.get_filename() for part in message.iter_attachments()]
        self.assertEqual(names, ["piccolo.pdf"])
        self.assertIn("enorme.pdf", message.get_body().get_content())

    def test_membership_submit_with_manual_review_sends_email(self) -> None:
        ref = main.build_payment_reference("MEM")
        self.refs.append(ref)
        session = SessionLocal()
        session.add(
            MembershipPayment(
                reference=ref, email="maria@example.test", sport_type=main.SPORT_TYPES[0],
                amount_cents=5000, status="paid",
            )
        )
        session.commit()
        session.close()

        response = self.client.post(
            "/tesseramento/dati",
            data={
                "payment_reference": ref, "first_name": "Maria", "last_name": "Prova",
                "email": "maria@example.test", "phone": "333", "birth_date": "1990-01-01",
                "birth_place": "Udine", "residence": "Via Roma", "codice_fiscale": "X",
                "document_type": "CI", "document_number": "CA12345AA",
                "medical_certificate_expiry": (date.today() + timedelta(days=300)).isoformat(),
                "sport_type": main.SPORT_TYPES[0], "request_manual_review": "1",
            },
            files=[
                ("identity_documents", ("ci.jpg", io.BytesIO(b"a"), "image/jpeg")),
                ("health_documents", ("ts.jpg", io.BytesIO(b"b"), "image/jpeg")),
                ("medical_documents", ("cm.pdf", io.BytesIO(b"c"), "application/pdf")),
            ],
            follow_redirects=False,
        )
        self.assertEqual(response.status_code, 303)
        session = SessionLocal()
        payment = session.query(MembershipPayment).filter_by(reference=ref).one()
        self.member_ids.append(payment.member_id)
        session.close()
        self.assertEqual(len(_FakeSMTP.sent), 1)
        names = sorted(part.get_filename() for part in _FakeSMTP.sent[0].iter_attachments())
        self.assertEqual(names, ["ci.jpg", "cm.pdf", "ts.jpg"])


if __name__ == "__main__":
    unittest.main()
