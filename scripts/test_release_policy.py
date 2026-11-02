"""Negative controls for accidental reintroduction of the old publisher."""

import json
from pathlib import Path
import shutil
import tempfile
import unittest

from check_release_policy import policy_errors


class ReleasePolicyTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        source = Path(__file__).resolve().parents[1]
        shutil.copytree(source / ".github/workflows", self.root / ".github/workflows")
        (self.root / "frontend").mkdir()
        shutil.copy(source / "frontend/vercel.json", self.root / "frontend/vercel.json")
        self.cd = self.root / ".github/workflows/cd.yml"

    def test_current_ci_is_read_only(self):
        self.assertEqual(policy_errors(self.root), [])

    def test_old_demo_publisher_is_rejected_even_under_another_filename(self):
        (self.root / ".github/workflows/publish.yml").write_text("""on: {push: {branches: [main]}}
jobs:
  publish:
    runs-on: ubuntu-latest
    env:
      VERCEL_TOKEN: ${{ secrets.VERCEL_TOKEN }}
    steps:
      - run: vercel --prod --env NEXT_PUBLIC_DEMO_MODE=true
""")
        self.assertTrue(any("publish.yml" in error for error in policy_errors(self.root)))

    def test_push_trigger_cannot_be_restored(self):
        self.cd.write_text(self.cd.read_text().replace("workflow_dispatch:", "push:"))
        self.assertIn("the retired CD workflow must be manual-only", policy_errors(self.root))

    def test_manual_workflow_cannot_invoke_a_deployer(self):
        self.cd.write_text(self.cd.read_text().replace('echo "Automatic production publishing is retired."', "curl https://example.invalid/deploy"))
        self.assertIn("retired CD may only print literal instructions", policy_errors(self.root))

    def test_git_autodeploy_cannot_be_enabled(self):
        path = self.root / "frontend/vercel.json"
        config = json.loads(path.read_text())
        config["git"]["deploymentEnabled"] = True
        path.write_text(json.dumps(config))
        self.assertIn("frontend Git deployments must remain disabled", policy_errors(self.root))


if __name__ == "__main__":
    unittest.main()
