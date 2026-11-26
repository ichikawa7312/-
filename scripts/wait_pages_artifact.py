"""Wait for the exact Pages upload; never select an older attempt's artifact.

The public upload-pages-artifact output is artifact_id, not a digest. Verify
that ID against the workflow-run catalog without claiming a local byte proof.
The workflow also downloads this unique name through the Actions runtime SDK
before deploy-pages uses its separate runtime artifact catalog.
"""
from dataclasses import dataclass
import json
import os
import re
import sys
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import HTTPRedirectHandler, Request, build_opener


class ArtifactError(RuntimeError):
    """Metadata or authority did not match the upload we intend to publish."""


class TemporaryArtifactError(ArtifactError):
    """A bounded retry can resolve transport unavailability."""


@dataclass(frozen=True)
class ExpectedArtifact:
    repository: str
    run_id: int
    run_attempt: int
    artifact_id: int
    name: str
    head_sha: str


def positive_integer(value, field):
    if not isinstance(value, str) or not re.fullmatch(r"[1-9][0-9]*", value):
        raise ArtifactError("Missing or invalid " + field)
    return int(value)


def configuration(environment):
    repository = environment.get("SENTLOG_PAGES_REPOSITORY", "")
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repository):
        raise ArtifactError("Missing or invalid repository")
    run_id = positive_integer(environment.get("SENTLOG_PAGES_RUN_ID"), "run ID")
    attempt = positive_integer(environment.get("SENTLOG_PAGES_RUN_ATTEMPT"), "run attempt")
    artifact_id = positive_integer(environment.get("SENTLOG_PAGES_ARTIFACT_ID"), "upload artifact ID")
    name = environment.get("SENTLOG_PAGES_ARTIFACT_NAME", "")
    if name != f"github-pages-{run_id}-{attempt}":
        raise ArtifactError("Artifact name does not identify this run and attempt")
    head_sha = environment.get("SENTLOG_PAGES_HEAD_SHA", "")
    if not re.fullmatch(r"[0-9a-f]{40}", head_sha):
        raise ArtifactError("Missing or invalid workflow commit")
    token = environment.get("SENTLOG_PAGES_TOKEN", "")
    if not token or any(character.isspace() for character in token):
        raise ArtifactError("GitHub artifact read token is unavailable")
    # Keep the token outside the dataclass, its repr and all diagnostic output.
    return ExpectedArtifact(repository, run_id, attempt, artifact_id, name, head_sha), token


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, new_url):
        return None


def fetch_artifacts(expected, token, *, opener=None):
    query = urlencode({"name": expected.name, "per_page": 100, "page": 1})
    url = f"https://api.github.com/repos/{expected.repository}/actions/runs/{expected.run_id}/artifacts?{query}"
    request = Request(url, headers={
        "Accept": "application/vnd.github+json",
        "Authorization": "Bearer " + token,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "sentlog-pages-artifact-readiness",
        "Cache-Control": "no-cache",
    })
    try:
        with (opener or build_opener(NoRedirect())).open(request, timeout=10) as response:
            # The unique-name response is tiny. An oversized or partial catalog
            # cannot silently become a successful identity check.
            raw = response.read(1_000_001)
            if len(raw) > 1_000_000:
                raise ArtifactError("GitHub returned an oversized artifact catalog")
    except HTTPError as error:
        if error.code in (401, 403):
            raise ArtifactError(f"GitHub denied artifact metadata access (HTTP {error.code}); actions: read is required") from None
        if error.code == 429 or 500 <= error.code <= 599:
            raise TemporaryArtifactError(f"GitHub artifact metadata is temporarily unavailable (HTTP {error.code})") from None
        raise ArtifactError(f"GitHub artifact metadata request failed (HTTP {error.code})") from None
    except (URLError, TimeoutError, OSError):
        # Do not print response bodies, request headers or transport exceptions;
        # they are outside the trusted diagnostics and can contain credentials.
        raise TemporaryArtifactError("GitHub artifact metadata transport is temporarily unavailable") from None
    try:
        return json.loads(raw)
    except (ValueError, UnicodeError):
        raise ArtifactError("GitHub returned an invalid artifact catalog") from None


def matching_artifact(catalog, expected):
    if not isinstance(catalog, dict) or not isinstance(catalog.get("artifacts"), list):
        raise ArtifactError("GitHub returned an invalid artifact catalog")
    rows = catalog["artifacts"]
    count = catalog.get("total_count")
    # With a unique name there should be at most one result. Refuse an incomplete
    # first page instead of assuming later pages cannot contain duplicates.
    if type(count) is not int or count < 0 or count != len(rows) or count > 100:
        raise ArtifactError("GitHub returned an incomplete artifact catalog")
    if any(not isinstance(row, dict) for row in rows):
        raise ArtifactError("GitHub returned invalid artifact metadata")
    if any(row.get("id") == expected.artifact_id and row.get("name") != expected.name for row in rows):
        raise ArtifactError("The uploaded artifact ID has a different name")
    candidates = [row for row in rows if row.get("name") == expected.name]
    if not candidates:
        return None
    if len(candidates) != 1:
        raise ArtifactError("Multiple artifacts have the current attempt's name")
    artifact = candidates[0]
    run = artifact.get("workflow_run")
    if type(artifact.get("id")) is not int or artifact["id"] != expected.artifact_id:
        raise ArtifactError("The visible artifact ID differs from the completed upload")
    if not isinstance(run, dict) or type(run.get("id")) is not int or run["id"] != expected.run_id:
        raise ArtifactError("The visible artifact belongs to a different workflow run")
    if run.get("head_sha") != expected.head_sha:
        raise ArtifactError("The visible artifact belongs to a different commit")
    if artifact.get("expired") is not False:
        raise ArtifactError("The uploaded artifact is expired or its expiry state is unknown")
    if type(artifact.get("size_in_bytes")) is not int or artifact["size_in_bytes"] <= 0:
        raise ArtifactError("The uploaded artifact has no valid byte size")
    digest = artifact.get("digest")
    if digest is not None and (not isinstance(digest, str) or not re.fullmatch(r"sha256:[0-9a-f]{64}", digest)):
        raise ArtifactError("The uploaded artifact has an invalid digest")
    return artifact


def wait_for_artifact(expected, fetch, *, attempts=12, interval=3, sleep=time.sleep, output=print):
    if type(attempts) is not int or attempts < 2 or interval < 0:
        raise ValueError("Artifact visibility checks require at least two bounded attempts")
    previous = None
    for attempt in range(1, attempts + 1):
        try:
            artifact = matching_artifact(fetch(), expected)
        except TemporaryArtifactError:
            artifact = None
        proof = None if artifact is None else (artifact["id"], artifact["name"],
            artifact["workflow_run"]["id"], artifact["workflow_run"]["head_sha"],
            artifact["size_in_bytes"], artifact.get("digest"))
        if proof is not None and proof == previous:
            output(f"PASS Pages artifact visible: {expected.name}; ID {expected.artifact_id}; commit {expected.head_sha}")
            return artifact
        previous = proof
        if attempt < attempts:
            output(f"Waiting for Pages upload visibility ({attempt}/{attempts})")
            sleep(interval)
    raise ArtifactError(f"The exact Pages upload was not consistently visible after {attempts} checks")


def main(environment=None):
    try:
        expected, token = configuration(os.environ if environment is None else environment)
        wait_for_artifact(expected, lambda: fetch_artifacts(expected, token))
    except ArtifactError as error:
        print("ERROR: " + str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
