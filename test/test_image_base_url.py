from __future__ import annotations

import unittest
from unittest import mock

from starlette.requests import Request

from api.support import resolve_image_base_url
from services.config import config


def make_request(headers: dict[str, str] | None = None, scheme: str = "http", host: str = "image2.vvooo.top") -> Request:
    raw_headers = [(b"host", host.encode())]
    for key, value in (headers or {}).items():
        raw_headers.append((key.encode(), value.encode()))
    scope = {
        "type": "http",
        "http_version": "1.1",
        "method": "GET",
        "scheme": scheme,
        "path": "/api/image-tasks",
        "raw_path": b"/api/image-tasks",
        "query_string": b"",
        "headers": raw_headers,
        "server": (host, 443 if scheme == "https" else 80),
        "client": ("1.2.3.4", 12345),
    }
    return Request(scope)


def patch_base_url(value: str) -> mock._patch:
    patcher = mock.patch.object(type(config), "base_url", new_callable=mock.PropertyMock, return_value=value)
    patcher.start()
    return patcher


class ResolveImageBaseUrlTests(unittest.TestCase):
    def setUp(self):
        self._patcher = patch_base_url("")
        self.addCleanup(self._patcher.stop)

    def test_uses_forwarded_proto_when_behind_tls_proxy(self):
        request = make_request({"x-forwarded-proto": "https"}, scheme="http")
        self.assertEqual(resolve_image_base_url(request), "https://image2.vvooo.top")

    def test_takes_first_value_of_forwarded_proto_list(self):
        request = make_request({"x-forwarded-proto": "https, http"}, scheme="http")
        self.assertEqual(resolve_image_base_url(request), "https://image2.vvooo.top")

    def test_falls_back_to_request_scheme(self):
        request = make_request(scheme="https")
        self.assertEqual(resolve_image_base_url(request), "https://image2.vvooo.top")

    def test_forwarded_host_wins(self):
        request = make_request({"x-forwarded-proto": "https", "x-forwarded-host": "cdn.example.com"})
        self.assertEqual(resolve_image_base_url(request), "https://cdn.example.com")

    def test_ignores_untrusted_proto_value(self):
        request = make_request({"x-forwarded-proto": "ftp"}, scheme="https")
        self.assertEqual(resolve_image_base_url(request), "https://image2.vvooo.top")

    def test_configured_base_url_takes_precedence(self):
        self._patcher.stop()
        patcher = patch_base_url("https://configured.example.com")
        self.addCleanup(patcher.stop)
        request = make_request({"x-forwarded-proto": "http"}, scheme="http")
        self.assertEqual(resolve_image_base_url(request), "https://configured.example.com")


if __name__ == "__main__":
    unittest.main()
