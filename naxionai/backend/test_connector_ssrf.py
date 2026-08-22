"""
Tests for connector_client.py's SSRF/redirect/redaction guard (connector_client.py:1-249).

Known, intentionally-uncovered gap (documented here, not fixed — out of
scope for this pass): resolve_url() only checks that a request stays on the
SAME origin as the configured base_url (connector_client.py:38-49); it never
validates that the base_url itself isn't a private/loopback/link-local/cloud-
metadata address. Contrast with rag/pipeline.py's `_assert_public_url`
(test_rag_ssrf.py), which DOES perform that check via `ipaddress`.
"""

import httpx
import pytest
import respx

import connector_client as cc


class TestResolveUrl:
    def test_path_on_same_origin_resolves(self):
        url = cc.resolve_url("https://api.example.com", "/v1/things")
        assert url == "https://api.example.com/v1/things"

    def test_absolute_url_escaping_origin_is_rejected(self):
        with pytest.raises(cc.ConnectorError):
            cc.resolve_url("https://api.example.com", "https://evil.example.net/steal")

    def test_scheme_downgrade_is_rejected(self):
        with pytest.raises(cc.ConnectorError):
            cc.resolve_url("https://api.example.com", "http://api.example.com/x")

    def test_private_ip_base_url_is_NOT_rejected_documented_gap(self):
        # Documented gap: resolve_url has no opinion about the base_url's own
        # target — an operator (or a compromised connector config) pointing
        # base_url at a cloud-metadata endpoint is accepted with no error.
        url = cc.resolve_url("http://169.254.169.254", "/latest/meta-data/")
        assert url == "http://169.254.169.254/latest/meta-data/"


class TestRedactUrl:
    def test_api_key_query_param_is_redacted(self):
        redacted = cc.redact_url("https://api.example.com/x?api_key=super-secret", "api_key", "api_key")
        assert "super-secret" not in redacted
        assert "REDACTED" in redacted

    def test_userinfo_is_always_stripped(self):
        redacted = cc.redact_url("https://user:pass@api.example.com/x", "none", None)
        assert "user" not in redacted
        assert "pass" not in redacted

    def test_case_mismatched_param_name_is_NOT_redacted_documented_gap(self):
        # Documented gap: the match is case-sensitive (connector_client.py:76:
        # `k == auth_name`) — an auth_name of "key" does not redact "KEY".
        redacted = cc.redact_url("https://api.example.com/x?KEY=super-secret", "api_key", "key")
        assert "super-secret" in redacted


class TestReadOnlyGate:
    @pytest.mark.asyncio
    async def test_write_method_blocked_when_write_disabled(self):
        result = await cc.call_connector(
            "https://api.example.com", False, "none", None, None, "header", None, None,
            "POST", "/x",
        )
        assert result["ok"] is False
        assert "read-only" in result["error"]

    @pytest.mark.asyncio
    @respx.mock
    async def test_get_is_allowed_when_write_disabled(self):
        respx.get("https://api.example.com/x").mock(return_value=httpx.Response(200, json={"ok": True}))
        result = await cc.call_connector(
            "https://api.example.com", False, "none", None, None, "header", None, None,
            "GET", "/x",
        )
        assert result["ok"] is True
        assert result["body"] == {"ok": True}


class TestRedirectGuard:
    @pytest.mark.asyncio
    @respx.mock
    async def test_same_origin_redirect_is_followed(self):
        respx.get("https://api.example.com/old").mock(
            return_value=httpx.Response(302, headers={"location": "https://api.example.com/new"})
        )
        respx.get("https://api.example.com/new").mock(return_value=httpx.Response(200, json={"landed": True}))
        result = await cc.call_connector(
            "https://api.example.com", False, "none", None, None, "header", None, None,
            "GET", "/old",
        )
        assert result["ok"] is True
        assert result["body"] == {"landed": True}

    @pytest.mark.asyncio
    @respx.mock
    async def test_cross_origin_redirect_is_blocked(self):
        respx.get("https://api.example.com/old").mock(
            return_value=httpx.Response(302, headers={"location": "https://evil.example.net/steal"})
        )
        result = await cc.call_connector(
            "https://api.example.com", False, "none", None, None, "header", None, None,
            "GET", "/old",
        )
        assert result["ok"] is False
        assert "blocked redirect" in result["error"]

    @pytest.mark.asyncio
    @respx.mock
    async def test_redirect_chain_revalidates_against_original_base_every_hop(self):
        # Hop 1 lands on-origin, hop 2 tries to pivot off-origin — must be
        # caught even though hop 1 was fine (connector_client.py uses
        # base_parsed from the ORIGINAL base_url at every hop, not the
        # previous hop's host).
        respx.get("https://api.example.com/a").mock(
            return_value=httpx.Response(302, headers={"location": "https://api.example.com/b"})
        )
        respx.get("https://api.example.com/b").mock(
            return_value=httpx.Response(302, headers={"location": "https://evil.example.net/c"})
        )
        result = await cc.call_connector(
            "https://api.example.com", False, "none", None, None, "header", None, None,
            "GET", "/a",
        )
        assert result["ok"] is False
        assert "blocked redirect" in result["error"]

    @pytest.mark.asyncio
    @respx.mock
    async def test_exceeding_max_redirects_is_reported(self):
        # The loop makes MAX_REDIRECTS + 1 requests (hop indices 0..MAX_REDIRECTS)
        # before giving up on the final one — register exactly that many mocks,
        # each redirecting to the next; the last one's target is never fetched.
        for i in range(cc.MAX_REDIRECTS + 1):
            respx.get(f"https://api.example.com/hop{i}").mock(
                return_value=httpx.Response(302, headers={"location": f"https://api.example.com/hop{i + 1}"})
            )
        result = await cc.call_connector(
            "https://api.example.com", False, "none", None, None, "header", None, None,
            "GET", "/hop0",
        )
        assert result["ok"] is False
        assert "too many redirects" in result["error"]
