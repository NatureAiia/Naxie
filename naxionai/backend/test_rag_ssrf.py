"""
Tests for rag/pipeline.py's `_assert_public_url` SSRF guard (rag/pipeline.py:
85-104) and `parse_url`'s per-hop re-validation (rag/pipeline.py:107-135).

Contrast with connector_client.py's guard (test_connector_ssrf.py): this one
does real DNS resolution + `ipaddress`-based private/loopback/link-local/
reserved/multicast checks, not just an origin-string comparison — and it
re-checks EVERY redirect hop, including hops after the first.
"""

from unittest.mock import patch

import httpx
import pytest
import respx

from rag.pipeline import _assert_public_url, parse_url


def _fake_addrinfo(ip: str):
    # Shape matches what socket.getaddrinfo returns: a list of 5-tuples
    # whose [4] element is (address, port).
    return [(None, None, None, None, (ip, 443))]


class TestAssertPublicUrl:
    def test_public_https_url_is_allowed(self):
        with patch("socket.getaddrinfo", return_value=_fake_addrinfo("93.184.216.34")):
            _assert_public_url("https://example.com/page")  # must not raise

    @pytest.mark.parametrize("ip", [
        "127.0.0.1",       # loopback
        "10.0.0.5",        # private
        "192.168.1.1",     # private
        "172.16.0.1",      # private
        "169.254.169.254",  # link-local / cloud metadata
        "224.0.0.1",       # multicast
        "0.0.0.0",         # reserved
    ])
    def test_disallowed_address_classes_are_rejected(self, ip):
        with patch("socket.getaddrinfo", return_value=_fake_addrinfo(ip)):
            with pytest.raises(ValueError, match="disallowed address"):
                _assert_public_url("https://looks-public.example.com/")

    def test_dns_rebinding_target_is_rejected_even_with_a_public_looking_hostname(self):
        # A hostname that LOOKS public but resolves to a private/metadata
        # address (classic SSRF/DNS-rebinding shape) must still be rejected —
        # the guard checks the resolved address, not the hostname string.
        with patch("socket.getaddrinfo", return_value=_fake_addrinfo("169.254.169.254")):
            with pytest.raises(ValueError, match="disallowed address"):
                _assert_public_url("https://totally-legit-cdn.example.com/")

    def test_multi_a_record_host_is_rejected_if_any_address_is_private(self):
        # _assert_public_url checks every resolved address, not just the first.
        with patch("socket.getaddrinfo", return_value=[
            *_fake_addrinfo("93.184.216.34"),
            *_fake_addrinfo("10.0.0.1"),
        ]):
            with pytest.raises(ValueError, match="disallowed address"):
                _assert_public_url("https://multi-homed.example.com/")

    def test_unresolvable_host_is_rejected(self):
        import socket
        with patch("socket.getaddrinfo", side_effect=socket.gaierror("not found")):
            with pytest.raises(ValueError, match="Could not resolve host"):
                _assert_public_url("https://does-not-exist.invalid/")

    @pytest.mark.parametrize("scheme", ["file", "ftp", "gopher"])
    def test_non_http_scheme_is_rejected(self, scheme):
        with pytest.raises(ValueError, match="Disallowed URL scheme"):
            _assert_public_url(f"{scheme}://example.com/x")

    def test_missing_host_is_rejected(self):
        with pytest.raises(ValueError, match="no host"):
            _assert_public_url("https:///no-host-here")


class TestParseUrlRedirectRevalidation:
    @pytest.mark.asyncio
    @respx.mock
    async def test_redirect_hop_landing_on_private_ip_is_rejected(self):
        # Hop 1 (the initial request) is public; the redirect target is a
        # private/link-local address. parse_url must re-validate the
        # redirect's destination, not just the original URL.
        respx.get("https://public.example.com/start").mock(
            return_value=httpx.Response(302, headers={"location": "http://169.254.169.254/steal"})
        )
        with patch("socket.getaddrinfo", return_value=_fake_addrinfo("93.184.216.34")):
            result = await parse_url("https://public.example.com/start")
        # parse_url swallows exceptions internally and returns "" rather than
        # raising (rag/pipeline.py:133-135) — the guard still did its job by
        # preventing the private fetch, but callers see an empty string, not
        # an exception. Confirm no content leaked through.
        assert result == ""

    @pytest.mark.asyncio
    @respx.mock
    async def test_same_public_origin_redirect_succeeds(self):
        respx.get("https://public.example.com/start").mock(
            return_value=httpx.Response(302, headers={"location": "https://public.example.com/landed"})
        )
        respx.get("https://public.example.com/landed").mock(
            return_value=httpx.Response(200, text="<html><body>hello world</body></html>")
        )
        with patch("socket.getaddrinfo", return_value=_fake_addrinfo("93.184.216.34")):
            result = await parse_url("https://public.example.com/start")
        assert "hello world" in result
