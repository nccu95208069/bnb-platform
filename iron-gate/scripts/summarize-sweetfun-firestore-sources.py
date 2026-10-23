#!/usr/bin/env python3
"""Read aggregate Gmail/LINE Firestore source markers without printing documents.

This is an observation aid, not a complete event watermark: Gmail new-order and
cancel flows, Sheet edits, OS writes, and in-flight requests require separate
checks. Firestore pages are read sequentially rather than in one snapshot.
"""

import argparse
import hashlib
import json
import subprocess
import sys
import urllib.parse
import urllib.request


COLLECTIONS = (
    "gmail_processing_claims",
    "gmail_order_watermarks",
    "line_order_v2_journal",
    "line_order_v2_events",
    "line_finance_v1_books/sweetfun/entries",
    "line_finance_v1_books/sweetfun/outbox",
)


def access_token(gcloud):
    result = subprocess.run([gcloud, "auth", "print-access-token"],
                            capture_output=True, text=True, check=True)
    token = result.stdout.strip()
    if not token or any(char.isspace() for char in token):
        raise ValueError("INVALID_ACCESS_TOKEN")
    return token


def summarize_collection(project, path, token):
    endpoint = ("https://firestore.googleapis.com/v1/projects/" +
                urllib.parse.quote(project, safe="") +
                "/databases/(default)/documents/" +
                urllib.parse.quote(path, safe="/"))
    count = 0
    newest = None
    entries = {}
    page_token = None
    while True:
        params = {"pageSize": "1000"}
        if page_token:
            params["pageToken"] = page_token
        request = urllib.request.Request(
            endpoint + "?" + urllib.parse.urlencode(params),
            headers={"Authorization": "Bearer " + token,
                     "Accept": "application/json"}, method="GET")
        with urllib.request.urlopen(request, timeout=30) as response:
            page = json.load(response)
        for document in page.get("documents", []):
            name = document["name"].split("/documents/", 1)[-1]
            if name in entries:
                raise ValueError("DUPLICATE_FIRESTORE_DOCUMENT")
            fields = json.dumps(document.get("fields", {}), ensure_ascii=False,
                                sort_keys=True, separators=(",", ":"))
            entries[name] = hashlib.sha256(fields.encode("utf-8")).hexdigest()
            count += 1
            update = document.get("updateTime")
            if update and (newest is None or update > newest):
                newest = update
        page_token = page.get("nextPageToken")
        if not page_token:
            break
    inventory = json.dumps(entries, ensure_ascii=False, sort_keys=True,
                           separators=(",", ":"))
    return {"collection": path, "count": count, "latest_update_time": newest,
            "content_digest": hashlib.sha256(inventory.encode("utf-8")).hexdigest()}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--project", required=True)
    parser.add_argument("--gcloud", default="gcloud")
    args = parser.parse_args()
    token = access_token(args.gcloud)
    result = [summarize_collection(args.project, path, token)
              for path in COLLECTIONS]
    inventory = json.dumps(result, ensure_ascii=False, sort_keys=True,
                           separators=(",", ":"))
    print(json.dumps({"scope": "selected live Gmail and LINE Firestore sources",
                      "consistency": "sequential read; not a database snapshot",
                      "inventory_digest": hashlib.sha256(inventory.encode("utf-8")).hexdigest(),
                      "collections": result}, ensure_ascii=False, sort_keys=True))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        print("Source marker summary failed: REDACTED_ERROR", file=sys.stderr)
        sys.exit(1)
