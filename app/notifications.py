import logging
import os

logger = logging.getLogger(__name__)


def send_notification(title: str, body: str) -> None:
    from settings import get_setting
    if get_setting("notifications_enabled") != "true":
        return
    urls_raw = get_setting("apprise_urls", "") or ""
    urls = [u.strip() for u in urls_raw.splitlines() if u.strip()]
    if not urls:
        return
    try:
        import apprise
        a = apprise.Apprise()
        for url in urls:
            a.add(url)
        a.notify(title=title, body=body)
        logger.info("Notification sent: %s", title)
    except Exception as exc:
        logger.warning("Notification failed: %s", exc)
