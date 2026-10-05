"""Testi e URL per condividere iscrizione/donazione Move for Gaza."""

from __future__ import annotations

from urllib.parse import quote

from .m4g_common import format_price
from .m4g_config import M4G_EVENT
from .models import M4gRegistration

_SHARE = M4G_EVENT.get("share") or {}
_INSTAGRAM_POST = _SHARE.get("instagram_post_url") or (
    "https://www.instagram.com/p/Dd65foPiL6K/?img_index=1"
)
_PUBLIC_LINK_LABEL = _SHARE.get("public_link_label") or "www.move-4-gaza.com"

SHARE_INVITE_PARAGRAPHS = (
    "Aiutaci a far crescere questa bellissima iniziativa: condividila con amicə, "
    "parentə e colleghə e invitalə a partecipare o a fare una donazione.",
    "Più siamo, più possiamo fare la differenza. Ogni iscrizione, ogni donazione "
    "e ogni condivisione ci aiuta ad arrivare ancora più lontano! 🙌",
    "Grazie",
)


def share_invite_text() -> str:
    return "\n\n".join(SHARE_INVITE_PARAGRAPHS)


def share_public_url(reg: M4gRegistration | None = None) -> str:
    link = (
        _SHARE.get("public_link")
        or M4G_EVENT.get("public_site")
        or "https://www.move-4-gaza.com"
    )
    return str(link).strip().rstrip("/")


def share_public_link_label() -> str:
    return _PUBLIC_LINK_LABEL


def share_whatsapp_message(reg: M4gRegistration) -> str:
    site = share_public_url(reg)
    if reg.activity == "donation":
        amount = format_price(reg.amount_cents or 0)
        return (
            f"Ho donato {amount} € a Move for Gaza.\n"
            "Insieme possiamo fare di più: partecipa o dona anche tu!\n"
            f"{site}"
        )
    return (
        "Mi sono iscrittə a Move for Gaza.\n"
        "Insieme possiamo fare di più: partecipa anche tu!\n"
        f"{site}"
    )


def share_whatsapp_url(reg: M4gRegistration) -> str:
    return f"https://wa.me/?text={quote(share_whatsapp_message(reg))}"


def share_email_block(reg: M4gRegistration, confirm_link: str = "") -> str:
    site = share_public_url(reg)
    wa = share_whatsapp_url(reg)
    ig = _INSTAGRAM_POST
    card_line = (
        f"\nNel riepilogo trovi anche una card da screenshot: {confirm_link}\n"
        if confirm_link and reg.activity == "donation"
        else ""
    )
    return (
        f"\n{share_invite_text()}\n\n"
        f"Condividi su WhatsApp: {wa}\n"
        f"Riposta una storia su Instagram: {ig}\n"
        f"Sito: {site} ({share_public_link_label()})\n"
        f"{card_line}"
    )


def registration_share_context(reg: M4gRegistration) -> dict[str, str | bool | tuple[str, ...]]:
    return {
        "share_invite_paragraphs": SHARE_INVITE_PARAGRAPHS,
        "share_public_url": share_public_url(reg),
        "share_public_link_label": share_public_link_label(),
        "share_whatsapp_url": share_whatsapp_url(reg),
        "share_instagram_url": _INSTAGRAM_POST,
        "is_donation": reg.activity == "donation",
    }
