#!/usr/bin/env bash
# Pushes state/state.json to the signals-data branch as a single commit (no history, so
# saving every 30 minutes does not grow the repository).
set -e
cd state
[ -f state.json ] || exit 0
git add state.json
tree=$(git write-tree)
commit=$(GIT_AUTHOR_NAME=stock-signals GIT_AUTHOR_EMAIL=actions@users.noreply.github.com \
  GIT_COMMITTER_NAME=stock-signals GIT_COMMITTER_EMAIL=actions@users.noreply.github.com \
  git commit-tree "$tree" -m state)
git push -qf origin "$commit:refs/heads/signals-data"
