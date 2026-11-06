#!/usr/bin/env bash
# One-time publication of both repositories and the six demo issues.
# Requires: gh (logged in), git. Run from the autofix-agent root:
#   bash scripts/publish.sh [github-user]
set -euo pipefail

OWNER="${1:-$(gh api user -q .login)}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "== 1/3 autofix-agent -> github.com/$OWNER/autofix-agent"
if ! git remote get-url origin >/dev/null 2>&1; then
  gh repo create "autofix-agent" --public --source . --push \
    --description "Mini SWE-agent: reproduces a GitHub issue in a Docker sandbox, fixes it, proves it, opens a PR (Claude Opus 5.5, hand-written agent loop)"
else
  git push -u origin main
fi

echo "== 2/3 demo-inventory-api -> github.com/$OWNER/demo-inventory-api"
DEMO="$(mktemp -d)"
git archive HEAD demo-repo | tar -x -C "$DEMO" --strip-components=1
(
  cd "$DEMO"
  git init -q -b main
  git add -A
  git commit -q -m "chore: demo inventory api with six planted bugs (see issues.json)"
  gh repo create "demo-inventory-api" --public --source . --push \
    --description "Express + TypeScript API with six planted bugs; target of autofix-agent demos"
)

echo "== 3/3 labels and issues (in order, so numbers match issues.json)"
REPO="$OWNER/demo-inventory-api"
for label in bug api pricing search data-loss "good first issue" ai-generated; do
  gh label create "$label" --repo "$REPO" --force >/dev/null 2>&1 || true
done
COUNT=$(node -e 'console.log(require("./demo-repo/issues.json").issues.length)')
for ((i = 0; i < COUNT; i++)); do
  TITLE=$(node -e "console.log(require('./demo-repo/issues.json').issues[$i].title)")
  LABELS=$(node -e "console.log(require('./demo-repo/issues.json').issues[$i].labels.join(','))")
  BODY="$(mktemp)"
  node -e "process.stdout.write(require('./demo-repo/issues.json').issues[$i].body)" > "$BODY"
  gh issue create --repo "$REPO" --title "$TITLE" --body-file "$BODY" --label "$LABELS"
  rm -f "$BODY"
done

echo
echo "Done. Next, with ANTHROPIC_API_KEY and GITHUB_TOKEN exported:"
echo "  pnpm eval                       # opens the six PRs and rewrites docs/eval-results.md"
echo "  gh secret set ANTHROPIC_API_KEY # so fix-live.yml can run"
echo "  gh secret set AUTOFIX_GITHUB_TOKEN  # PAT with repo scope on $REPO (optional, for cross-repo PRs from CI)"
