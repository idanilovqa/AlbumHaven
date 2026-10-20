"""One-shot, read-only admission for supplemental new-feature CI.

This does not certify native coverage or replace the native prerequisite owner.
The first attempt always holds; a rerun observes only a bounded current snapshot.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import re
import signal
import time
from urllib.parse import urlencode, urlsplit
import urllib.request


API = "https://api.github.com"
REPOSITORY = "idanilovqa/AlbumHaven"
BRANCH = "2026-10-03-album-tops"
WORKFLOW = ".github/workflows/pr-gates.yml"
CONTROLS = frozenset(("run_reviews", "skip_tests", "ci:full-review",
                      "ci:focused-e2e", "ci:focused-related"))
FOUNDATIONS = ("JavaScript Tests (Portable)", "Component Tests (Pinned Chrome)",
               "JavaScript Tests (Windows Contract)", "Python Tests")
PREREQUISITES = ("PR Review Scope", "Review Prerequisites")
TERMINAL = frozenset(("success", "failure", "timed_out", "cancelled", "skipped",
                     "neutral", "action_required", "stale", "startup_failure"))
REQUEST_SECONDS = 10
DEADLINE_SECONDS = 75
PAGE_SIZE = 100
MAX_PAGES = 10


class Hold(Exception):
    def __init__(self, reason):
        super().__init__(reason)
        self.reason = reason


class DeadlineExceeded(Exception):
    pass


def positive(value):
    return type(value) is int and value > 0


def check(condition, reason="metadata-invalid"):
    if not condition:
        raise Hold(reason)


def normalized_pr(pr, repository):
    check(isinstance(pr, dict), "invalid-input")
    number = pr.get("number")
    head = pr.get("head")
    check(positive(number) and type(pr.get("draft")) is bool, "invalid-input")
    check(isinstance(head, dict) and isinstance(head.get("repo"), dict), "invalid-input")
    sha = head.get("sha")
    check(isinstance(sha, str) and re.fullmatch(r"[0-9a-f]{40}", sha), "invalid-input")
    check(repository == REPOSITORY and head["repo"].get("full_name") == REPOSITORY
          and head.get("ref") == BRANCH and pr.get("state") == "open", "invalid-input")
    labels = pr.get("labels")
    check(isinstance(labels, list), "invalid-input")
    check(all(isinstance(item, dict) and isinstance(item.get("name"), str)
              for item in labels), "invalid-input")
    names = sorted({item["name"].strip() for item in labels if item["name"].strip()})
    controls = [name for name in names if name in CONTROLS
                or name.startswith(("ci:e2e:", "ci:e2e-performance:"))]
    return {"repository": repository, "number": number, "branch": BRANCH,
            "head_sha": sha, "draft": pr["draft"], "control_labels": controls,
            "all_labels": names}


def admit(event, *, attempt, get_json, observed_at):
    """Inspect a bounded public metadata snapshot; never retry or change state."""
    result = {"schema_version": 1, "decision": "hold", "reason_codes": [],
              "observed_at": observed_at, "authority": "supplemental-only",
              "trigger": None, "current": None, "native": None,
              "inspected": [], "coverage": "unproven"}
    started = time.monotonic()

    def remaining():
        left = DEADLINE_SECONDS - (time.monotonic() - started)
        check(left > 0, "deadline-exceeded")
        return left

    def read(route, query=None):
        url = API + "/repos/" + REPOSITORY + route
        if query is not None:
            url += "?" + urlencode(query)
        timeout = min(REQUEST_SECONDS, remaining())
        try:
            body = get_json(url, timeout=timeout)
        except DeadlineExceeded:
            raise Hold("deadline-exceeded") from None
        except Exception:
            remaining()
            raise Hold("api-error") from None
        result["inspected"].append({"url": url, "fetched_at": datetime.now(timezone.utc).isoformat(),
                                    "body": body})
        remaining()
        check(isinstance(body, dict))
        return body

    def listing(route, key, query=None):
        values, identities, total = [], set(), None
        for page in range(1, MAX_PAGES + 1):
            body = read(route, {**(query or {}), "per_page": PAGE_SIZE, "page": page})
            count, items = body.get("total_count"), body.get(key)
            check(type(count) is int and 0 <= count <= PAGE_SIZE * MAX_PAGES)
            if total is None:
                total = count
            check(count == total and isinstance(items, list))
            check(len(items) == min(PAGE_SIZE, max(0, total - len(values))))
            for item in items:
                check(isinstance(item, dict) and positive(item.get("id")))
                check(item["id"] not in identities)
                identities.add(item["id"])
            values.extend(items)
            if len(values) == total:
                return values
        raise Hold("metadata-invalid")

    def run_identity(run, workflow_id, trigger):
        check(isinstance(run, dict))
        check(all(positive(run.get(key)) for key in ("id", "workflow_id", "run_number", "run_attempt")))
        check(run["workflow_id"] == workflow_id and run.get("head_sha") == trigger["head_sha"]
              and run.get("head_branch") == BRANCH and run.get("event") == "pull_request")
        check(run.get("path") == WORKFLOW and run.get("name") == "PR Gates")
        check(isinstance(run.get("repository"), dict)
              and run["repository"].get("full_name") == REPOSITORY)
        check(isinstance(run.get("head_repository"), dict)
              and run["head_repository"].get("full_name") == REPOSITORY)
        prs = run.get("pull_requests")
        check(isinstance(prs, list) and len(prs) == 1)
        check(isinstance(prs[0], dict) and prs[0].get("number") == trigger["number"])
        check(isinstance(prs[0].get("head"), dict)
              and prs[0]["head"].get("sha") == trigger["head_sha"]
              and prs[0]["head"].get("ref") == BRANCH)

    def ready(run):
        if run.get("conclusion") == "cancelled":
            raise Hold("native-cancelled")
        check(run.get("status") == "completed", "native-not-ready")
        check(run.get("conclusion") in ("success", "failure"))

    try:
        check(positive(attempt) and isinstance(observed_at, str) and observed_at, "invalid-input")
        check(isinstance(event, dict) and isinstance(event.get("repository"), dict), "invalid-input")
        check(event.get("action") in ("opened", "synchronize", "reopened",
                                      "ready_for_review", "labeled", "unlabeled"), "invalid-input")
        trigger = normalized_pr(event.get("pull_request"), event["repository"].get("full_name"))
        check(type(event.get("number")) is int and event["number"] == trigger["number"], "invalid-input")
        result["trigger"] = trigger
        if attempt == 1:
            raise Hold("initial-attempt")
        current_body = read("/pulls/" + str(trigger["number"]))
        try:
            current = normalized_pr(current_body, REPOSITORY)
        except Hold:
            raise Hold("context-changed") from None
        result["current"] = current
        check(all(trigger[key] == current[key] for key in
                  ("repository", "number", "branch", "head_sha", "draft", "control_labels")),
              "context-changed")
        workflow = read("/actions/workflows/pr-gates.yml")
        check(positive(workflow.get("id")) and workflow.get("path") == WORKFLOW
              and workflow.get("name") == "PR Gates" and workflow.get("state") == "active")
        runs = listing("/actions/workflows/pr-gates.yml/runs", "workflow_runs",
                       {"head_sha": trigger["head_sha"], "branch": BRANCH, "event": "pull_request"})
        check(bool(runs), "native-not-ready")
        numbers = set()
        for run in runs:
            run_identity(run, workflow["id"], trigger)
            check(run["run_number"] not in numbers)
            numbers.add(run["run_number"])
        # An older numbered run can have an active rerun. A later completed
        # run must not hide any native work already observed in this snapshot.
        check(all(run.get("status") == "completed" for run in runs), "native-not-ready")
        latest = max(runs, key=lambda item: item["run_number"])
        ready(latest)
        native = {"id": latest["id"], "run_number": latest["run_number"],
                  "attempt": latest["run_attempt"], "workflow_id": workflow["id"],
                  "head_sha": latest["head_sha"], "status": latest["status"],
                  "conclusion": latest["conclusion"], "jobs": []}
        result["native"] = native
        route = "/actions/runs/" + str(latest["id"])
        detail = read(route)
        exact = read(route + "/attempts/" + str(latest["run_attempt"]))
        for view in (detail, exact):
            run_identity(view, workflow["id"], trigger)
            check(all(view.get(key) == latest.get(key) for key in
                      ("id", "run_number", "workflow_id", "head_sha", "head_branch",
                       "event", "run_attempt", "status", "conclusion")))
            ready(view)
        jobs = listing(route + "/attempts/" + str(latest["run_attempt"]) + "/jobs", "jobs")
        native["jobs"] = jobs
        for job in jobs:
            check(job.get("run_id") == latest["id"] and type(job.get("run_id")) is int
                  and job.get("run_attempt") == latest["run_attempt"]
                  and type(job.get("run_attempt")) is int
                  and job.get("head_sha") == trigger["head_sha"]
                  and job.get("head_branch") == BRANCH and job.get("workflow_name") == "PR Gates")
            check(isinstance(job.get("name"), str) and job["name"])
            check(job.get("status") == "completed", "native-not-ready")
            check(job.get("conclusion") in TERMINAL)
        for name in PREREQUISITES:
            owners = [job for job in jobs if job["name"] == name]
            check(len(owners) == 1 and owners[0]["conclusion"] == "success", "missing-prerequisite")
        for name in FOUNDATIONS:
            owners = [job for job in jobs if job["name"] == name]
            check(len(owners) == 1, "foundation-unadmitted")
            check(isinstance(owners[0].get("started_at"), str) and owners[0]["started_at"]
                  and owners[0]["conclusion"] in ("success", "failure", "timed_out", "cancelled"),
                  "foundation-unadmitted")
        remaining()
        result["decision"] = "admit"
    except Hold as error:
        result["reason_codes"].append(error.reason)
    except DeadlineExceeded:
        result["reason_codes"].append("deadline-exceeded")
    except Exception:
        result["reason_codes"].append("metadata-invalid")
    return result


class PublicRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, newurl):
        target = urlsplit(newurl)
        if (target.scheme, target.netloc) != ("https", "api.github.com"):
            raise ValueError("Refusing a non-public-API redirect")
        return super().redirect_request(request, response, code, message, headers, newurl)


def public_json(url, *, timeout):
    target = urlsplit(url)
    if (target.scheme, target.netloc) != ("https", "api.github.com") or target.fragment:
        raise ValueError("Invalid public API target")
    request = urllib.request.Request(url, headers={
        "Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "AlbumHaven-supplemental-CI",
    })
    opener = urllib.request.build_opener(PublicRedirects())
    with opener.open(request, timeout=timeout) as response:
        data = response.read(8 * 1024 * 1024 + 1)
        if len(data) > 8 * 1024 * 1024:
            raise ValueError("Oversized public metadata response")
        return json.loads(data)


def cli():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--event", required=True, type=Path)
    parser.add_argument("--attempt", required=True, type=int)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    observed_at = datetime.now(timezone.utc).isoformat()
    try:
        event = json.loads(args.event.read_text(encoding="utf-8"))
    except Exception:
        event = None

    def deadline(signum, frame):
        raise DeadlineExceeded()

    previous = signal.signal(signal.SIGALRM, deadline)
    signal.setitimer(signal.ITIMER_REAL, DEADLINE_SECONDS)
    try:
        result = admit(event, attempt=args.attempt, get_json=public_json, observed_at=observed_at)
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous)
    # Exclusive creation refuses an earlier attempt's success record.
    with args.output.open("x", encoding="utf-8") as stream:
        json.dump(result, stream, indent=2, sort_keys=True)
        stream.write("\n")
    return 0 if result["decision"] == "admit" else 1


if __name__ == "__main__":
    raise SystemExit(cli())
