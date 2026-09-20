#!/usr/bin/env bash
# Report which open upstream pull requests are already in this fork, and which are new.
#
#   scripts/upstream-pr-status.sh              full table (every open upstream PR)
#   scripts/upstream-pr-status.sh --new-only   only the new ones; exit 1 when any exist
#
# "Merged" is decided by ancestry, not by a message pattern: the PR's head commit
# (fetched as refs/remotes/upstream/pr/<n>) is an ancestor of this repo's main branch.
# That covers PRs we merged ourselves, PRs upstream merged, and PRs whose content came
# in through another branch.
set -uo pipefail

UPSTREAM_REPO="${UPSTREAM_REPO:-xnohat/webobsidian}"
UPSTREAM_URL="${UPSTREAM_URL:-https://github.com/xnohat/webobsidian.git}"
BRANCH="${BRANCH:-main}"
NEW_ONLY=0
[[ "${1:-}" == "--new-only" ]] && NEW_ONLY=1

REPO_DIR="$(git rev-parse --show-toplevel)"
cd "$REPO_DIR"

git remote get-url upstream >/dev/null 2>&1 || git remote add upstream "$UPSTREAM_URL"
echo "fetching upstream pull refs…" >&2
git fetch --quiet upstream '+refs/pull/*/head:refs/remotes/upstream/pr/*' 2>/dev/null || \
  echo "warning: could not refresh upstream pull refs (using the ones already fetched)" >&2

mapfile -t PRS < <(gh pr list --repo "$UPSTREAM_REPO" --state open --limit 200 \
  --json number,title,author,createdAt \
  --jq '.[] | "\(.number)\t\(.createdAt[0:10])\t@\(.author.login)\t\(.title)"' | sort -n)
[[ ${#PRS[@]} -gt 0 ]] || { echo "no open upstream PRs"; exit 0; }

new_count=0
[[ $NEW_ONLY -eq 0 ]] && printf '%-6s %-11s %-16s %s\n' "PR" "CREATED" "AUTHOR" "STATUS → TITLE"
for row in "${PRS[@]}"; do
  n="${row%%$'\t'*}"
  rest="${row#*$'\t'}"
  created="${rest%%$'\t'*}"; rest="${rest#*$'\t'}"
  author="${rest%%$'\t'*}"; title="${rest#*$'\t'}"
  ref="refs/remotes/upstream/pr/$n"

  if ! git rev-parse --verify --quiet "$ref" >/dev/null; then
    status="UNKNOWN (ref not fetched)"
  elif git merge-base --is-ancestor "$ref" "$BRANCH" 2>/dev/null; then
    merge_commit="$(git log --merges --grep="upstream PR #$n:" -1 --pretty=%h "$BRANCH" 2>/dev/null)"
    status="merged${merge_commit:+ ($merge_commit)}"
  else
    status="NEW"; new_count=$((new_count + 1))
  fi

  if [[ $NEW_ONLY -eq 1 ]]; then
    [[ "$status" == "NEW" ]] && printf '%s\t%s\t%s\t%s\n' "$n" "$author" "$title" \
      "https://github.com/$UPSTREAM_REPO/pull/$n"
  else
    printf '%-6s %-11s %-16s %s → %s\n' "#$n" "$created" "$author" "$status" "$title"
  fi
done

if [[ $NEW_ONLY -eq 1 ]]; then
  echo "new upstream PRs: $new_count" >&2
  [[ $new_count -gt 0 ]] && exit 1
  exit 0
fi
echo
echo "open upstream PRs: ${#PRS[@]} | not yet in $BRANCH: $new_count"
if [[ $new_count -gt 0 ]]; then
  echo "sync one with: scripts/merge-upstream-pr.sh <pr-number>  (then verify with npm ci && npm test && npm run build)"
else
  echo "this fork is up to date with every open upstream PR."
fi
