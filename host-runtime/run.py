"""Start the private loopback-only host companion."""

import os

import uvicorn


if __name__ == "__main__":
    bind = os.getenv("HOST_RUNTIME_BIND", "127.0.0.1")
    if bind not in {"127.0.0.1", "::1", "localhost"}:
        raise SystemExit("HOST_RUNTIME_BIND must be loopback; remote access needs a reviewed relay")
    uvicorn.run(
        "app.main:app",
        host=bind,
        port=int(os.getenv("HOST_RUNTIME_PORT", "8765")),
        reload=False,
        access_log=False,
    )
