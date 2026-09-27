"""Pair the local companion without putting the one-time code in shell history."""

from __future__ import annotations

import asyncio
import getpass
import os
import sys

import httpx


async def main() -> int:
    token = os.getenv("HOST_RUNTIME_BEARER_TOKEN", "")
    host_id = os.getenv("HOST_ID", "owner-mac-android-emulator")
    property_id = os.getenv("PROPERTY_ID", "sweetfun") or "sweetfun"
    if len(token) < 32:
        print("HOST_RUNTIME_BEARER_TOKEN is missing from the private .env", file=sys.stderr)
        return 2

    code = getpass.getpass("Paste the 5-minute pairing code from Sweetfun OS: ").strip()
    if not code:
        print("No pairing code entered.", file=sys.stderr)
        return 2

    try:
        async with httpx.AsyncClient(timeout=30) as client:
            response = await client.post(
                "http://127.0.0.1:8765/api/v1/host-agents/bnb-customer-service/pair",
                headers={"Authorization": f"Bearer {token}"},
                json={"pairing_code": code, "host_id": host_id, "property_id": property_id},
            )
        if response.is_error:
            print(f"Pairing failed ({response.status_code}): {response.json().get('detail', 'request_failed')}", file=sys.stderr)
            return 1
        result = response.json()
        print(
            "Paired: "
            f"agent={result['agent_id']} property={result['property_id']} "
            f"host={result['host_id']} expires={result['token_expires_at']}"
        )
        print("The host token was stored in the macOS Keychain and was not displayed.")
        return 0
    except (httpx.HTTPError, ValueError, KeyError) as exc:
        print(f"Could not pair with the local companion: {type(exc).__name__}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
