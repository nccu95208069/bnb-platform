#!/usr/bin/env python3
"""Compare selected Sweetfun Firestore source and isolated restore documents.

The access token and document payloads stay in memory. Output contains only
collection counts and equality flags; this is a scoped drill, not a full
database checksum or a statement that live data did not change after backup.
"""

import argparse
import hashlib
import json
import subprocess
import sys
import urllib.parse
import urllib.request


COLLECTIONS = (
    "line_finance_v1_books/sweetfun/entries",
    "line_finance_v1_books/sweetfun/versions",
    "line_finance_v1_books/sweetfun/operations",
    "line_finance_v1_books/sweetfun/events",
    "line_finance_v1_books/sweetfun/audit",
    "line_finance_v1_books/sweetfun/outbox",
    "line_finance_v1_books/sweetfun/projection_receipts",
    "line_finance_v1_books/sweetfun/orders",
    "line_finance_v1_books/sweetfun/booking_operations",
    "line_finance_v1_books/sweetfun/order_operations",
    "line_finance_v1_books/sweetfun/external_receipts",
    "line_finance_v1_books/sweetfun/contexts",
    "line_finance_v1_books/sweetfun/control",
    "line_order_v2_journal",
    "line_order_v2_events",
    "gmail_processing_claims",
    "gmail_order_watermarks",
)


def digest(value):
    data = json.dumps(value, ensure_ascii=False, sort_keys=True,
                      separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(data).hexdigest()


def gcloud_token(gcloud):
    result = subprocess.run([gcloud, "auth", "print-access-token"],
                            capture_output=True, text=True, check=True)
    token = result.stdout.strip()
    if not token or any(char.isspace() for char in token):
        raise ValueError("INVALID_ACCESS_TOKEN")
    return token


def collection_documents(project, database, path, token):
    endpoint = ("https://firestore.googleapis.com/v1/projects/" +
                urllib.parse.quote(project, safe="") + "/databases/" +
                urllib.parse.quote(database, safe="()") + "/documents/" +
                urllib.parse.quote(path, safe="/"))
    rows = {}
    page_token = None
    while True:
        params = {"pageSize": "1000"}
        if page_token:
            params["pageToken"] = page_token
        req = urllib.request.Request(
            endpoint + "?" + urllib.parse.urlencode(params),
            headers={"Authorization": "Bearer " + token,
                     "Accept": "application/json"}, method="GET")
        with urllib.request.urlopen(req, timeout=30) as response:
            page = json.load(response)
        for document in page.get("documents", []):
            name = document["name"].split("/documents/", 1)[-1]
            if name in rows:
                raise ValueError("DUPLICATE_FIRESTORE_DOCUMENT")
            rows[name] = digest(document.get("fields", {}))
        page_token = page.get("nextPageToken")
        if not page_token:
            return rows


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--project", required=True)
    parser.add_argument("--restored-database", required=True)
    parser.add_argument("--gcloud", default="gcloud")
    args = parser.parse_args()
    if args.restored_database == "(default)" or not args.restored_database.startswith(
            "sweetfun-migration-drill-"):
        raise ValueError("RESTORE_MUST_BE_ISOLATED")
    token = gcloud_token(args.gcloud)
    report = []
    for path in COLLECTIONS:
        live = collection_documents(args.project, "(default)", path, token)
        restored = collection_documents(args.project, args.restored_database,
                                        path, token)
        common = live.keys() & restored.keys()
        report.append({"collection": path, "live": len(live),
                       "restored": len(restored),
                       "same": sum(live[key] == restored[key] for key in common),
                       "changed": sum(live[key] != restored[key] for key in common),
                       "live_only": len(live.keys() - restored.keys()),
                       "restored_only": len(restored.keys() - live.keys())})
    print(json.dumps({"scope": "selected Sweetfun finance, LINE and Gmail collections",
                      "documents": report}, ensure_ascii=False))
    if any(row["restored"] == 0 for row in report[:7]) or any(
            row["changed"] or row["live_only"] or row["restored_only"]
            for row in report):
        return 2
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        print("Firestore restore verification failed: REDACTED_ERROR", file=sys.stderr)
        sys.exit(1)
