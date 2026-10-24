from __future__ import annotations

import os
import unittest
from unittest import mock

os.environ.setdefault("NEXI_ENDPOINT", "https://example.test/nexi")
os.environ.setdefault("NEXI_SUCCESS_URL", "https://example.test/nexi/success")
os.environ.setdefault("NEXI_FAILURE_URL", "https://example.test/nexi/failure")
os.environ.setdefault("SESSION_SECRET", "test-nexi-secret")
os.environ.setdefault("M4G_SITE_PASSWORD", "test-m4g-password")

from fastapi.testclient import TestClient  # noqa: E402

from app import main  # noqa: E402
from app.database import SessionLocal  # noqa: E402
from app.models import MembershipPayment  # noqa: E402
from app.nexi import NexiXpayClient  # noqa: E402

TEST_CLIENT = NexiXpayClient(
    merchant_id="ALIAS_TEST",
    api_key="CHIAVE_SEGRETA",
    endpoint="https://example.test/nexi",
    success_url="https://example.test/nexi/success",
    failure_url="https://example.test/nexi/failure",
)


def _notification(ref: str, esito: str = "OK", importo: int = 5000, **over: str) -> dict[str, str]:
    params = {
        "alias": "ALIAS_TEST",
        "codTrans": ref,
        "esito": esito,
        "importo": str(importo),
        "divisa": "EUR",
        "data": "20261024",
        "orario": "101500",
        "codAut": "ABC123" if esito == "OK" else "",
    }
    params.update(over)
    params["mac"] = TEST_CLIENT.result_mac(params)
    return params


class NexiClientTests(unittest.TestCase):
    def test_verify_result_roundtrip_and_tamper(self) -> None:
        params = _notification("MEM-T1")
        self.assertTrue(TEST_CLIENT.verify_result(params))
        self.assertFalse(TEST_CLIENT.verify_result({**params, "importo": "1"}))
        self.assertFalse(TEST_CLIENT.verify_result({**params, "mac": ""}))

    def test_urlpost_only_when_requested(self) -> None:
        plain = TEST_CLIENT.prepare_payment(1000, "MEM-T2", "x")
        self.assertNotIn("urlpost", plain.payload)
        with_notify = TEST_CLIENT.prepare_payment(
            1000, "MEM-T2", "x", notify_url="https://example.test/nexi/notifica"
        )
        self.assertEqual(with_notify.payload["urlpost"], "https://example.test/nexi/notifica")


class NexiNotificationRouteTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._client = TestClient(main.app)
        cls.client = cls._client.__enter__()

    @classmethod
    def tearDownClass(cls) -> None:
        cls._client.__exit__(None, None, None)

    def setUp(self) -> None:
        self._patches = [
            mock.patch.object(main, "nexi_client", TEST_CLIENT),
            mock.patch.object(main, "_send_membership_completion_email", return_value=True),
            mock.patch.object(main, "_send_membership_staff_email", return_value=True),
        ]
        for patch in self._patches:
            patch.start()
        self.completion_email = main._send_membership_completion_email
        self.refs: list[str] = []

    def tearDown(self) -> None:
        for patch in self._patches:
            patch.stop()
        session = SessionLocal()
        session.query(MembershipPayment).filter(
            MembershipPayment.reference.in_(self.refs)
        ).delete(synchronize_session=False)
        session.commit()
        session.close()

    def _payment(self, status: str = "pending") -> str:
        ref = main.build_payment_reference("MEM")
        self.refs.append(ref)
        session = SessionLocal()
        session.add(
            MembershipPayment(
                reference=ref,
                email="socio@example.test",
                sport_type=main.SPORT_TYPES[0],
                amount_cents=5000,
                status=status,
            )
        )
        session.commit()
        session.close()
        return ref

    def _status(self, ref: str) -> str:
        session = SessionLocal()
        payment = session.query(MembershipPayment).filter_by(reference=ref).one()
        status = payment.status
        session.close()
        return status

    def test_ok_marks_paid_and_sends_link_once(self) -> None:
        ref = self._payment()
        for _ in range(2):
            response = self.client.post("/nexi/notifica", data=_notification(ref))
            self.assertEqual(response.status_code, 200)
        self.assertEqual(self._status(ref), "paid")
        self.assertEqual(self.completion_email.call_count, 1)
        link = self.completion_email.call_args.args[1]
        self.assertIn(f"/tesseramento/dati?ref={ref}", link)
        # il modulo ora è accessibile
        form = self.client.get("/tesseramento/dati", params={"ref": ref})
        self.assertEqual(form.status_code, 200)
        self.assertIn('name="payment_reference"', form.text)

    def test_browser_return_after_notification_does_not_resend(self) -> None:
        ref = self._payment()
        self.client.post("/nexi/notifica", data=_notification(ref))
        self.client.get("/nexi/success", params={"ref": ref})
        self.assertEqual(self.completion_email.call_count, 1)

    def test_bad_mac_is_ignored(self) -> None:
        ref = self._payment()
        params = {**_notification(ref), "mac": "0" * 40}
        response = self.client.post("/nexi/notifica", data=params)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self._status(ref), "pending")
        self.completion_email.assert_not_called()

    def test_wrong_amount_is_ignored(self) -> None:
        ref = self._payment()
        response = self.client.post("/nexi/notifica", data=_notification(ref, importo=100))
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self._status(ref), "pending")

    def test_ko_marks_failed(self) -> None:
        ref = self._payment()
        self.client.post("/nexi/notifica", data=_notification(ref, esito="KO"))
        self.assertEqual(self._status(ref), "failed")

    def test_ko_does_not_undo_paid(self) -> None:
        ref = self._payment(status="paid")
        self.client.post("/nexi/notifica", data=_notification(ref, esito="KO"))
        self.assertEqual(self._status(ref), "paid")

    def test_checkout_sends_urlpost(self) -> None:
        response = self.client.post(
            "/tesseramento/pagamento",
            data={"sport_type": main.SPORT_TYPES[0], "email": "socio@example.test"},
        )
        self.assertEqual(response.status_code, 200)
        notify_url = main._membership_notify_url()
        self.assertTrue(notify_url.endswith("/nexi/notifica"))
        self.assertIn(f'name="urlpost" value="{notify_url}"', response.text)
        session = SessionLocal()
        latest = session.query(MembershipPayment).order_by(MembershipPayment.id.desc()).first()
        self.refs.append(latest.reference)
        session.close()


if __name__ == "__main__":
    unittest.main()
