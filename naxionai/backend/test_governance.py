"""
Tests for governance.py's constraint-matching core (governance.py:56-202).

Thresholds under test, exactly as implemented (governance.py:113):
    strong = len(overlap) >= 2 and len(overlap) >= ceil(len(rule_words) * 0.4)
"""

import governance as gov


def _constraint(rule, **overrides):
    base = {
        "id": "c1", "policy_name": "Test Policy", "rule": rule,
        "severity": "hard", "category": "general", "reviewed": True, "accepted": True,
    }
    base.update(overrides)
    return base


class TestIsProhibitive:
    def test_negation_word_is_prohibitive(self):
        assert gov.is_prohibitive("Never share customer payment details externally")

    def test_prohibit_variants(self):
        for rule in [
            "Sharing raw data is prohibited",
            "Exporting records is forbidden",
            "Publishing drafts is banned",
            "Avoid contacting suppliers directly",
            "This is off-limits for the marketing team",
        ]:
            assert gov.is_prohibitive(rule), rule

    def test_obligation_is_not_prohibitive(self):
        # An affirmative obligation ("must include") can't be judged violated
        # by a keyword-overlap check — it never hard-blocks.
        assert not gov.is_prohibitive("Always include a disclaimer in every report")


class TestContentWords:
    def test_short_words_and_stopwords_dropped(self):
        words = gov._gov_content_words("The customer data report is due")
        # "the"/"is"/"due" are short; "customer"/"data"/"report" are in GOV_STOPWORDS
        assert words == []

    def test_distinctive_words_kept(self):
        words = gov._gov_content_words("Never contact external suppliers directly")
        assert "external" in words
        assert "suppliers" in words
        assert "directly" in words
        # "never" and "contact" are short/stopword-like or filtered by length
        assert "never" not in words


class TestCheckActionAgainstConstraints:
    def test_no_match_below_two_word_overlap(self):
        # Rule shares only one distinctive word with the action -> never blocks,
        # regardless of the 40% threshold.
        c = _constraint("Never publish unreviewed financial statements externally")
        hits = gov.check_action_against_constraints("Publish the quarterly newsletter", [c])
        assert hits == []

    def test_match_at_two_words_and_forty_percent(self):
        # "never" is dropped as a GOV_STOPWORD, leaving 5 distinctive rule
        # words: publish, unreviewed, financial, statements, externally.
        # ceil(5 * 0.4) = 2, so the >=2-overlap and >=40%-of-rule thresholds
        # both resolve to "need at least 2 overlapping words".
        c = _constraint("Never publish unreviewed financial statements externally")
        action = "Publish the unreviewed financial statement to the public website"
        hits = gov.check_action_against_constraints(action, [c])
        assert len(hits) == 1
        assert hits[0]["violated"][0] is c

    def test_unaccepted_constraint_never_matches(self):
        c = _constraint("Never publish unreviewed financial statements externally", accepted=False)
        action = "Publish the unreviewed financial statement externally"
        assert gov.check_action_against_constraints(action, [c]) == []

    def test_non_prohibitive_rule_never_matches(self):
        c = _constraint("Always publish unreviewed financial statements externally")
        action = "Publish the unreviewed financial statement externally"
        assert gov.check_action_against_constraints(action, [c]) == []

    def test_rule_under_two_content_words_never_matches(self):
        # "Never export data" -> after stopword/length filtering, "export" is
        # the only distinctive word (data is a stopword) -> len(rule_words) < 2.
        c = _constraint("Never export data")
        assert gov.check_action_against_constraints("Export the data now please", [c]) == []

    def test_empty_action_never_matches(self):
        c = _constraint("Never publish unreviewed financial statements externally")
        assert gov.check_action_against_constraints("", [c]) == []


class TestFilterEnforceable:
    def test_keeps_only_reviewed_accepted_hard(self):
        constraints = [
            _constraint("Never do X", reviewed=True, accepted=True, severity="hard"),
            _constraint("Never do Y", reviewed=False, accepted=True, severity="hard"),
            _constraint("Never do Z", reviewed=True, accepted=False, severity="hard"),
            _constraint("Never do W", reviewed=True, accepted=True, severity="soft"),
        ]
        kept = gov.filter_enforceable(constraints)
        assert len(kept) == 1
        assert kept[0]["rule"] == "Never do X"


class TestGateAction:
    def test_no_enforceable_constraints_passes(self):
        assert gov.gate_action("anything at all", []) == {"blocked": False, "violations": []}

    def test_blocks_on_strong_match(self):
        c = _constraint("Never publish unreviewed financial statements externally")
        result = gov.gate_action("Publish the unreviewed financial statement externally", [c])
        assert result["blocked"] is True
        assert result["violations"][0]["rule"] == c["rule"]

    def test_monitor_mode_never_blocks(self, monkeypatch):
        monkeypatch.setenv("NAXIONAI_GOVERNANCE_MODE", "monitor")
        c = _constraint("Never publish unreviewed financial statements externally")
        result = gov.gate_action("Publish the unreviewed financial statement externally", [c])
        assert result == {"blocked": False, "violations": []}

    def test_enforce_mode_is_default(self, monkeypatch):
        monkeypatch.delenv("NAXIONAI_GOVERNANCE_MODE", raising=False)
        assert gov._governance_enforces() is True

    def test_monitor_mode_is_case_and_whitespace_insensitive(self, monkeypatch):
        monkeypatch.setenv("NAXIONAI_GOVERNANCE_MODE", "  Monitor  ")
        assert gov._governance_enforces() is False


class TestBuildGovernancePrefix:
    def test_empty_policies_returns_empty_string(self):
        assert gov.build_governance_prefix([]) == ""

    def test_reference_only_policies_return_empty_string(self):
        policies = [{"name": "Reference doc", "body": "background info", "is_reference": True}]
        assert gov.build_governance_prefix(policies) == ""

    def test_non_reference_policy_is_included(self):
        policies = [{"name": "Data Policy", "body": "Never share customer data externally.", "is_reference": False}]
        prefix = gov.build_governance_prefix(policies)
        assert "Data Policy" in prefix
        assert "Never share customer data externally." in prefix
        assert prefix.startswith("=== GOVERNANCE POLICIES")
        assert prefix.rstrip().endswith("=== END GOVERNANCE ===")

    def test_budget_truncation_skips_only_the_oversized_policy(self):
        # A policy whose own block already exceeds MAX_PREFIX_BYTES is skipped
        # (bytes_so_far is NOT incremented for a skipped block, governance.py:
        # 192-194), so a later, small policy still fits and IS included.
        big_body = "x" * (gov.MAX_PREFIX_BYTES + 1000)
        policies = [
            {"name": "Huge Policy", "body": big_body, "is_reference": False},
            {"name": "Small Policy", "body": "Never do the thing.", "is_reference": False},
        ]
        prefix = gov.build_governance_prefix(policies)
        assert "1 policy file omitted to fit context budget" in prefix
        assert "Huge Policy" not in prefix
        assert "Small Policy" in prefix


class TestDescribeStepAction:
    def test_pulls_known_keys_from_args(self):
        desc = gov.describe_step_action("email.send", {"to": "ops@example.com", "subject": "Weekly report", "irrelevant": "x"})
        assert "email.send" in desc
        assert "ops@example.com" in desc
        assert "Weekly report" in desc
        assert "irrelevant" not in desc and "x" not in desc.split(" | ")

    def test_list_values_are_joined(self):
        desc = gov.describe_step_action("connector.call", {"to": ["a@x.com", "b@x.com"]})
        assert "a@x.com, b@x.com" in desc


class TestConsequentialToolsIsNotWired:
    def test_consequential_tools_defined_but_unused_marker(self):
        # This is a documentation test, not a behavior test: CONSEQUENTIAL_TOOLS
        # (governance.py:32-41) exists and is non-empty but — per the module's
        # own docstring — is not called from any tool-execution call site in
        # this pass. Asserting its shape here means a future wiring pass has a
        # test to update (rather than the constant silently drifting unnoticed).
        assert "email.send" in gov.CONSEQUENTIAL_TOOLS
        assert "code.exec" in gov.CONSEQUENTIAL_TOOLS
