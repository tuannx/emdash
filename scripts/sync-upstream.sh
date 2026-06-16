#!/usr/bin/env bash
# Sync emdash-origin fork with upstream and notify about changes
# Used by Hermes cron job — runs Tue/Thu 8:00 AM Vietnam (UTC+7)
set -euo pipefail

REPO_DIR="/Users/tuannguyen/Projects/AIKitLLC/emdash-origin"
STATE_FILE="$REPO_DIR/.upstream-last-hash"

cd "$REPO_DIR"

# ---- Stash local changes if any ----
STASH_NEEDED=false
if [ -n "$(git status --porcelain)" ]; then
  STASH_NEEDED=true
  git stash push -m "auto-stash before upstream sync $(date +%Y-%m-%d_%H%M)" 2>/dev/null
fi

# ---- Fetch upstream ----
echo "=== FETCHING UPSTREAM ==="
git fetch upstream --tags 2>&1

LAST_HASH=""
if [ -f "$STATE_FILE" ]; then
  LAST_HASH=$(cat "$STATE_FILE")
fi

CURRENT_HASH=$(git rev-parse upstream/main)

if [ "$LAST_HASH" = "$CURRENT_HASH" ]; then
  echo "NO_CHANGES: Already at $CURRENT_HASH"
  if [ "$STASH_NEEDED" = true ]; then
    git stash pop 2>/dev/null || true
  fi
  exit 0
fi

# ---- Show new commits ----
if [ -n "$LAST_HASH" ]; then
  NEW_COUNT=$(git rev-list --count "${LAST_HASH}..upstream/main" 2>/dev/null || echo "0")
  echo "=== NEW COMMITS ($NEW_COUNT total) ==="
  git log --oneline "${LAST_HASH}..upstream/main" --format="%h %s" 2>/dev/null || true
else
  echo "=== CURRENT UPSTREAM HEAD ==="
  git log --oneline upstream/main -1
fi

# ---- Merge upstream into fork's main ----
echo ""
echo "=== MERGING UPSTREAM ==="
git checkout main 2>/dev/null || true
if git merge upstream/main --ff-only 2>/dev/null; then
  echo "Fast-forward merge successful."
  echo "=== PUSHING TO FORK ==="
  git push origin main 2>&1
  echo "Push completed."
else
  # Try normal merge (shouldn't happen with a linear fork, but handle it)
  echo "Fast-forward not possible, trying normal merge..."
  git merge upstream/main --no-edit 2>&1
  echo "Merge completed."
  git push origin main 2>&1
  echo "Push completed."
fi

# ---- Restore local changes ----
if [ "$STASH_NEEDED" = true ]; then
  echo ""
  echo "=== RESTORING LOCAL CHANGES ==="
  git stash pop 2>/dev/null || echo "Stash pop skipped (may have conflicts)"
fi

# ---- Show new releases ----
echo ""
echo "=== NEW EMDASH RELEASES ==="
for pkg in "emdash" "@emdash-cms/cloudflare" "@emdash-cms/admin" "@emdash-cms/blocks" "@emdash-cms/x402" "create-emdash"; do
  LATEST=$(git tag -l "${pkg}@*" --sort=-version:refname | head -1 2>/dev/null)
  if [ -n "$LATEST" ]; then
    RELEASE_DATE=$(git log -1 --format=%cs "$LATEST" 2>/dev/null || echo "?")
    echo "$LATEST  ($RELEASE_DATE)"
  fi
done

# ---- Check AIKit site version gap ----
echo ""
echo "=== AIKIT SITE VERSION GAP ==="
AIKIT_SITE="/Users/tuannguyen/Projects/AIKitLLC/EmDash"
if [ -f "$AIKIT_SITE/package.json" ]; then
  CURRENT_EMDASH=$(node -e "const p=require('${AIKIT_SITE}/package.json'); console.log(p.dependencies.emdash)")
  CURRENT_CLOUDFLARE=$(node -e "const p=require('${AIKIT_SITE}/package.json'); console.log(p.dependencies['@emdash-cms/cloudflare'])")
  echo "emdash (site):          $CURRENT_EMDASH"
  echo "emdash (latest):        $(git tag -l 'emdash@*' --sort=-version:refname | head -1 2>/dev/null | sed 's/emdash@//')"
  echo "@emdash-cms/cloudflare (site): $CURRENT_CLOUDFLARE"
  echo "@emdash-cms/cloudflare (latest): $(git tag -l '@emdash-cms/cloudflare@*' --sort=-version:refname | head -1 2>/dev/null | sed 's/@emdash-cms\/cloudflare@//')"
fi

echo "$CURRENT_HASH" > "$STATE_FILE"
echo ""
echo "STATE_UPDATED: $CURRENT_HASH"
