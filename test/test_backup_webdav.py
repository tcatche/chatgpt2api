from __future__ import annotations

import unittest
from unittest import mock

from services.backup_service import (
    CloudflareR2Client,
    WebDAVTarget,
    _dav_time_to_iso,
    _make_backup_client,
    _parse_webdav_listing,
)
from services.config import _normalize_backup_settings, config


MULTISTATUS = b"""<?xml version="1.0" encoding="utf-8"?>
<multistatus xmlns="DAV:">
        <response>
                <href>/chatgpt2api/backups/</href>
                <propstat>
                        <prop>
                                <getcontentlength>0</getcontentlength>
                                <getlastmodified>Tue, 13 Oct 2026 08:31:13 GMT</getlastmodified>
                                <resourcetype><collection /></resourcetype>
                        </prop>
                        <status>HTTP/1.1 200 OK</status>
                </propstat>
        </response>
        <response>
                <href>/chatgpt2api/backups/backup-20261105T021913-1a2b.tar.gz.enc</href>
                <propstat>
                        <prop>
                                <getcontentlength>2048</getcontentlength>
                                <getlastmodified>Thu, 05 Nov 2026 02:19:13 GMT</getlastmodified>
                                <resourcetype />
                        </prop>
                        <status>HTTP/1.1 200 OK</status>
                </propstat>
        </response>
        <response>
                <href>/chatgpt2api/backups/backup-20261104T010000-ffff.tar.gz</href>
                <propstat>
                        <prop>
                                <getcontentlength>1024</getcontentlength>
                                <getlastmodified>Wed, 04 Nov 2026 01:00:00 GMT</getlastmodified>
                                <resourcetype />
                        </prop>
                        <status>HTTP/1.1 200 OK</status>
                </propstat>
        </response>
        <response>
                <href>/chatgpt2api/backups/backup-20261105T021913-1a2b.tar.gz.enc.prop</href>
                <propstat>
                        <prop>
                                <getcontentlength>12</getcontentlength>
                                <getlastmodified>Thu, 05 Nov 2026 02:19:14 GMT</getlastmodified>
                                <resourcetype />
                        </prop>
                        <status>HTTP/1.1 200 OK</status>
                </propstat>
        </response>
</multistatus>
"""


class WebDAVBackupTests(unittest.TestCase):
    def test_list_objects_issues_propfind_and_returns_backups(self):
        target = WebDAVTarget({
            "provider": "webdav",
            "webdav_url": "https://dav.test/root",
            "webdav_root_path": "chatgpt2api",
            "prefix": "backups",
        })
        captured: dict[str, object] = {}

        class FakeResponse:
            status_code = 207
            content = MULTISTATUS

        def fake_request(method, url, **kwargs):
            captured["method"] = method
            captured["url"] = url
            captured["depth"] = kwargs.get("headers", {}).get("Depth")
            return FakeResponse()

        with mock.patch.object(target.client.session, "request", side_effect=fake_request):
            items = target.list_objects()

        self.assertEqual(captured["method"], "PROPFIND")
        self.assertEqual(captured["depth"], "1")
        self.assertEqual(captured["url"], "https://dav.test/root/chatgpt2api/backups")
        self.assertEqual(len(items), 2)
        self.assertEqual(items[0]["key"], "backups/backup-20261105T021913-1a2b.tar.gz.enc")

    def test_parse_listing_keeps_only_backup_objects_newest_first(self):
        items = _parse_webdav_listing(MULTISTATUS, "backups")

        self.assertEqual(
            [item["key"] for item in items],
            [
                "backups/backup-20261105T021913-1a2b.tar.gz.enc",
                "backups/backup-20261104T010000-ffff.tar.gz",
            ],
        )
        self.assertEqual(items[0]["size"], 2048)
        self.assertEqual(items[0]["updated_at"], "2026-11-05T02:19:13Z")

    def test_parse_listing_rejects_malformed_xml(self):
        with self.assertRaises(Exception):
            _parse_webdav_listing(b"<multistatus", "backups")

    def test_dav_time_is_normalized_to_iso(self):
        self.assertEqual(_dav_time_to_iso("Tue, 13 Oct 2026 08:31:13 GMT"), "2026-10-13T08:31:13Z")
        self.assertEqual(_dav_time_to_iso(""), "")
        self.assertEqual(_dav_time_to_iso("not-a-date"), "not-a-date")


class BackupProviderSettingsTests(unittest.TestCase):
    def test_provider_defaults_to_r2_and_rejects_unknown(self):
        self.assertEqual(_normalize_backup_settings({})["provider"], "cloudflare_r2")
        self.assertEqual(
            _normalize_backup_settings({"provider": "ftp"})["provider"],
            "cloudflare_r2",
        )
        self.assertEqual(
            _normalize_backup_settings({"provider": "webdav"})["provider"],
            "webdav",
        )

    def test_webdav_fields_are_trimmed(self):
        settings = _normalize_backup_settings({
            "provider": "webdav",
            "webdav_url": "  https://dav.test/root/  ",
            "webdav_root_path": "/chatgpt2api/",
            "webdav_username": " u ",
        })
        self.assertEqual(settings["webdav_url"], "https://dav.test/root")
        self.assertEqual(settings["webdav_root_path"], "chatgpt2api")
        self.assertEqual(settings["webdav_username"], "u")

    def test_make_client_switches_by_provider(self):
        webdav_client = _make_backup_client({
            "provider": "webdav",
            "webdav_url": "https://dav.test/root",
            "webdav_root_path": "chatgpt2api",
            "prefix": "backups",
        })
        self.assertIsInstance(webdav_client, WebDAVTarget)
        self.assertEqual(
            webdav_client.client.remote_url(webdav_client.prefix),
            "https://dav.test/root/chatgpt2api/backups",
        )

        r2_client = _make_backup_client({"provider": "cloudflare_r2", "bucket": "b"})
        self.assertIsInstance(r2_client, CloudflareR2Client)

    def test_webdav_root_is_required_and_not_inherited(self):
        with mock.patch.object(
            config,
            "get_image_storage_settings",
            return_value={
                "webdav_url": "https://dav.test/root",
                "webdav_username": "u",
                "webdav_password": "p",
                "webdav_root_path": "chatgpt2api/images",
            },
        ):
            client = _make_backup_client({
                "provider": "webdav",
                "prefix": "backups",
            })

        # 只继承连接凭证，目录不继承
        self.assertEqual(client.client.url, "https://dav.test/root")
        self.assertEqual(client.client.root_path, "")
        with self.assertRaises(Exception):
            client.validate()


if __name__ == "__main__":
    unittest.main()
