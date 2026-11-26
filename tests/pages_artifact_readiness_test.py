"""Synthetic upload/catalog boundaries; no GitHub requests or credentials."""
import copy
import io
import json
from pathlib import Path
import sys
import unittest
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlparse

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from wait_pages_artifact import (ArtifactError, ExpectedArtifact, TemporaryArtifactError,
    configuration, fetch_artifacts, matching_artifact, wait_for_artifact)


EXPECTED = ExpectedArtifact("synthetic-owner/synthetic-repo", 1001, 2, 2002,
    "github-pages-1001-2", "a" * 40)


def artifact(**changes):
    value = {"id": EXPECTED.artifact_id, "name": EXPECTED.name, "expired": False,
        "size_in_bytes": 1234, "digest": "sha256:" + "b" * 64,
        "workflow_run": {"id": EXPECTED.run_id, "head_sha": EXPECTED.head_sha}}
    value.update(changes)
    return value


def catalog(*rows):
    return {"total_count": len(rows), "artifacts": list(rows)}


class FakeOpener:
    def __init__(self, response):
        self.response = response
        self.calls = []

    def open(self, request, timeout):
        self.calls.append((request, timeout))
        if isinstance(self.response, Exception):
            raise self.response
        return io.BytesIO(self.response)


class ArtifactReadinessTests(unittest.TestCase):
    def wait(self, responses, **options):
        pending = iter(responses)
        calls, delays, messages = [], [], []

        def fetch():
            calls.append(True)
            response = next(pending)
            if isinstance(response, Exception):
                raise response
            return response

        result = wait_for_artifact(EXPECTED, fetch, sleep=delays.append, output=messages.append, **options)
        return result, calls, delays, messages

    def test_upload_visibility_zero_then_exact_one_requires_stable_identity(self):
        result, calls, delays, messages = self.wait([catalog(), catalog(artifact()), catalog(artifact())])
        self.assertEqual(result["id"], EXPECTED.artifact_id)
        self.assertEqual(len(calls), 3)
        self.assertEqual(delays, [3, 3])
        self.assertTrue(messages[-1].startswith("PASS Pages artifact visible:"))

    def test_previous_attempts_never_satisfy_current_upload(self):
        older = artifact(id=1000, name="github-pages-1001-1")
        self.assertIsNone(matching_artifact(catalog(older), EXPECTED))
        result, calls, _, _ = self.wait([catalog(older), catalog(older, artifact()), catalog(artifact())])
        self.assertEqual(result["id"], EXPECTED.artifact_id)
        self.assertEqual(len(calls), 3)

    def test_old_artifact_with_current_name_is_rejected_instead_of_selected(self):
        with self.assertRaisesRegex(ArtifactError, "differs from the completed upload"):
            matching_artifact(catalog(artifact(id=1000)), EXPECTED)

    def test_same_name_duplicates_are_ambiguous_even_when_exact_id_is_present(self):
        with self.assertRaisesRegex(ArtifactError, "Multiple artifacts"):
            matching_artifact(catalog(artifact(id=1000), artifact()), EXPECTED)

    def test_wrong_name_for_exact_upload_id_is_rejected(self):
        with self.assertRaisesRegex(ArtifactError, "different name"):
            matching_artifact(catalog(artifact(name="github-pages-1001-1")), EXPECTED)

    def test_wrong_run_head_expiry_and_size_are_rejected(self):
        variants = [
            {"workflow_run": {"id": 9999, "head_sha": EXPECTED.head_sha}},
            {"workflow_run": {"id": EXPECTED.run_id, "head_sha": "c" * 40}},
            {"workflow_run": None}, {"expired": True}, {"expired": None},
            {"expired": 0}, {"size_in_bytes": 0}, {"size_in_bytes": True}, {"id": str(EXPECTED.artifact_id)},
            {"digest": "unverified"},
        ]
        for fields in variants:
            with self.subTest(fields=fields), self.assertRaises(ArtifactError):
                matching_artifact(catalog(artifact(**fields)), EXPECTED)

    def test_missing_optional_digest_does_not_invent_an_upload_byte_proof(self):
        row = artifact()
        del row["digest"]
        result, _, _, _ = self.wait([catalog(row), catalog(row)])
        self.assertNotIn("digest", result)

    def test_malformed_or_incomplete_pages_are_not_treated_as_ready(self):
        variants = [None, [], {}, {"total_count": 2, "artifacts": [artifact()]},
            {"total_count": True, "artifacts": [artifact()]}, {"total_count": 1, "artifacts": [None]},
            {"total_count": 101, "artifacts": [artifact()] * 101}]
        for response in variants:
            with self.subTest(response=type(response).__name__), self.assertRaises(ArtifactError):
                matching_artifact(response, EXPECTED)

    def test_finite_missing_or_unstable_visibility_cannot_publish(self):
        calls, delays = [], []

        def missing():
            calls.append(True)
            return catalog()

        with self.assertRaisesRegex(ArtifactError, "after 4 checks"):
            wait_for_artifact(EXPECTED, missing, attempts=4, sleep=delays.append, output=lambda _: None)
        self.assertEqual(len(calls), 4)
        self.assertEqual(delays, [3, 3, 3])
        with self.assertRaisesRegex(ArtifactError, "not consistently visible"):
            self.wait([catalog(artifact()), catalog(), catalog(artifact())], attempts=3)

    def test_temporary_transport_failure_restarts_consecutive_visibility(self):
        result, calls, _, _ = self.wait([catalog(artifact()), TemporaryArtifactError("temporary"),
            catalog(artifact()), catalog(artifact())])
        self.assertEqual(result["id"], EXPECTED.artifact_id)
        self.assertEqual(len(calls), 4)

    def test_permission_errors_fail_immediately_and_never_echo_untrusted_body(self):
        for status in (401, 403):
            secret = "synthetic-token-never-print"
            opener = FakeOpener(HTTPError("https://api.github.com/", status, secret, {}, io.BytesIO(secret.encode())))
            with self.subTest(status=status), self.assertRaisesRegex(ArtifactError, f"HTTP {status}") as failure:
                wait_for_artifact(EXPECTED, lambda: fetch_artifacts(EXPECTED, secret, opener=opener),
                    sleep=lambda _: self.fail("permission errors must not retry"), output=lambda _: None)
            self.assertNotIn(secret, str(failure.exception))
            self.assertEqual(len(opener.calls), 1)

    def test_http_and_network_retries_are_limited_to_transient_failures(self):
        for failure in (HTTPError("https://api.github.com/", 503, "untrusted", {}, None),
                        HTTPError("https://api.github.com/", 429, "untrusted", {}, None), URLError("untrusted")):
            with self.subTest(failure=type(failure).__name__), self.assertRaises(TemporaryArtifactError) as error:
                fetch_artifacts(EXPECTED, "synthetic-token", opener=FakeOpener(failure))
            self.assertNotIn("untrusted", str(error.exception))
        for status in (302, 404):
            with self.subTest(status=status), self.assertRaises(ArtifactError) as error:
                fetch_artifacts(EXPECTED, "synthetic-token", opener=FakeOpener(HTTPError("https://api.github.com/", status, "untrusted", {}, None)))
            self.assertNotIsInstance(error.exception, TemporaryArtifactError)

    def test_request_is_read_only_scoped_by_run_name_and_keeps_token_in_header(self):
        opener = FakeOpener(json.dumps(catalog(artifact())).encode())
        result = fetch_artifacts(EXPECTED, "synthetic-token", opener=opener)
        self.assertEqual(result, catalog(artifact()))
        request, timeout = opener.calls[0]
        url = urlparse(request.full_url)
        self.assertEqual(request.get_method(), "GET")
        self.assertEqual(url.netloc, "api.github.com")
        self.assertEqual(url.path, "/repos/synthetic-owner/synthetic-repo/actions/runs/1001/artifacts")
        self.assertEqual(parse_qs(url.query), {"name": [EXPECTED.name], "per_page": ["100"], "page": ["1"]})
        self.assertEqual(request.get_header("Authorization"), "Bearer synthetic-token")
        self.assertNotIn("synthetic-token", request.full_url)
        self.assertEqual(timeout, 10)

    def test_invalid_and_oversized_responses_fail_closed(self):
        for body in (b"not-json", b"\xff", b"x" * 1_000_001):
            with self.subTest(size=len(body)), self.assertRaises(ArtifactError):
                fetch_artifacts(EXPECTED, "synthetic-token", opener=FakeOpener(body))

    def test_environment_ties_name_to_this_attempt_and_requires_upload_output(self):
        environment = {"SENTLOG_PAGES_REPOSITORY": EXPECTED.repository, "SENTLOG_PAGES_RUN_ID": "1001",
            "SENTLOG_PAGES_RUN_ATTEMPT": "2", "SENTLOG_PAGES_ARTIFACT_ID": "2002",
            "SENTLOG_PAGES_ARTIFACT_NAME": EXPECTED.name, "SENTLOG_PAGES_HEAD_SHA": EXPECTED.head_sha,
            "SENTLOG_PAGES_TOKEN": "synthetic-token"}
        expected, token = configuration(environment)
        self.assertEqual(expected, EXPECTED)
        self.assertEqual(token, "synthetic-token")
        self.assertNotIn(token, repr(expected))
        for fields in ({"SENTLOG_PAGES_ARTIFACT_ID": ""}, {"SENTLOG_PAGES_RUN_ATTEMPT": "1"},
                       {"SENTLOG_PAGES_HEAD_SHA": "wrong"}, {"SENTLOG_PAGES_TOKEN": ""},
                       {"SENTLOG_PAGES_REPOSITORY": "../redirect/extra"}):
            with self.subTest(fields=list(fields)), self.assertRaises(ArtifactError):
                configuration({**environment, **fields})


if __name__ == "__main__":
    unittest.main()
