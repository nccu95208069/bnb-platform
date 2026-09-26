"""Status normalization shared by local runtime and remote BFF integrations."""

from typing import Any


HOST_STATUSES = {"offline", "login_required", "ready", "needs_reauth", "error"}


def normalize_transport_status(
    reachable: bool, payload: dict[str, Any] | None = None
) -> str:
    """Map host reachability to the UI contract without optimistic defaults."""
    if not reachable or not isinstance(payload, dict):
        return "offline"
    value = payload.get("host_status")
    return value if value in HOST_STATUSES else "error"
