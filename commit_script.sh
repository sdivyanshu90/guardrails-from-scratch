#!/bin/bash
set -e
FILES=$(git diff --name-only; git ls-files --others --exclude-standard)
for file in $FILES; do
  if [[ ! -f "$file" ]]; then continue; fi
  msg=""
  case "$file" in
    README.md) msg="docs: expand README modules section" ;;
    .gitignore) msg="chore: add gitignore" ;;
    config/*.yaml) msg="config: add $(basename "$file")" ;;
    tests/*|*/tests/*) msg="test: add $(basename "$file")" ;;
    packages/core/src/*) msg="feat(core): add $(basename "$file")" ;;
    packages/api/src/*) msg="feat(api): add $(basename "$file")" ;;
    package*.json|tsconfig*.json|tsup.config.ts|vitest.config.ts|docker-compose.yml|Dockerfile|monitoring/*|scripts/*) msg="chore: add $(basename "$file")" ;;
    *) msg="chore: update $file" ;;
  esac
  git add "$file"
  git commit -m "$msg"
  git push origin $(git branch --show-current)
  echo "COMMITTED: $(git rev-parse HEAD) $msg"
done
