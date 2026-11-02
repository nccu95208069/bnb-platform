"""Reject the retired automatic production publisher before merging changes."""

import json
from pathlib import Path
import re
import sys

import yaml


def policy_errors(root: Path) -> list[str]:
    errors = []
    config = json.loads((root / "frontend/vercel.json").read_text())
    if config.get("git", {}).get("deploymentEnabled") is not False:
        errors.append("frontend Git deployments must remain disabled")

    workflow_dir = root / ".github/workflows"
    cd_path = workflow_dir / "cd.yml"
    # BaseLoader preserves 'on' as a string instead of YAML 1.1's boolean True.
    cd = yaml.load(cd_path.read_text(), Loader=yaml.BaseLoader)
    if set(cd.get("on", {})) != {"workflow_dispatch"}:
        errors.append("the retired CD workflow must be manual-only")

    for path in sorted([*workflow_dir.glob("*.yml"), *workflow_dir.glob("*.yaml")]):
        workflow = yaml.load(path.read_text(), Loader=yaml.BaseLoader)
        for job in workflow.get("jobs", {}).values():
            # A reusable workflow can publish indirectly. This repository's CI
            # runs local checks; adding a publisher requires a policy review.
            if "uses" in job:
                errors.append(f"{path.name}: reusable workflow needs release-policy review")
            executable = json.dumps(job)
            if re.search(r"secrets\s*\.\s*VERCEL_TOKEN|--prod\b|vercel\s+(?:promote|alias|rollback|redeploy)\b", executable):
                errors.append(f"{path.name}: production publishing is not allowed in repository CI")
            for step in job.get("steps", []):
                action = step.get("uses", "").lower()
                if any(name in action for name in ("vercel", "railway", "deploy")):
                    errors.append(f"{path.name}: deployment action needs release-policy review")

    # Re-enabling CD in the GitHub settings must still be harmless.
    for job in cd.get("jobs", {}).values():
        if any(key in job for key in ("uses", "env", "environment", "secrets")):
            errors.append("retired CD may not access a release environment or secrets")
        for step in job.get("steps", []):
            if set(step) - {"name", "run"}:
                errors.append("retired CD may only print release instructions")
            for line in step.get("run", "").splitlines():
                if not re.fullmatch(r'echo "[A-Za-z0-9 ./_-]+"', line.strip()):
                    errors.append("retired CD may only print literal instructions")
    return errors


if __name__ == "__main__":
    failures = policy_errors(Path(__file__).resolve().parents[1])
    for failure in failures:
        print(f"Release policy: {failure}", file=sys.stderr)
    if failures:
        sys.exit(1)
    print("Release policy passed: CI cannot publish production; Vercel Git builds are disabled.")
