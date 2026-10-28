#!/usr/bin/env bash
set -euo pipefail

base="${1:-}"
if [ -z "$base" ] || ! git cat-file -e "${base}^{commit}" 2>/dev/null; then
  base="$(git rev-parse HEAD^ 2>/dev/null || true)"
fi

if [ -n "$base" ]; then
  changed="$(git diff --name-only --diff-filter=ACMR "$base" HEAD || true)"
else
  changed="$(git ls-files || true)"
fi

files="$(printf '%s\n' "$changed" | grep -vE '(^|/)(node_modules|dist|build|\.next|coverage)/|\.(md|lock)$' || true)"
if [ -z "$files" ]; then
  echo "No changed files to scan"
  exit 0
fi

secret_re='(-----BEGIN (RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----|AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{20,255}|xox[baprs]-[A-Za-z0-9-]{10,}|sk-[A-Za-z0-9]{20,})'

found=0
while IFS= read -r file; do
  [ -n "$file" ] || continue
  [ -f "$file" ] || continue
  if grep -IEn "$secret_re" "$file" >/dev/null 2>&1; then
    echo "::error file=$file::Potential secret detected"
    found=1
  fi
done <<< "$files"

env_files="$(printf '%s\n' "$files" | grep -E '(^|/)\.env(\.|$)' | grep -vE '\.env\.(example|sample|template)$' || true)"
if [ -n "$env_files" ]; then
  echo "::error::Committed environment file detected: $env_files"
  found=1
fi

if [ "$found" -ne 0 ]; then
  exit 1
fi

echo "Secret scan passed for $(printf '%s\n' "$files" | wc -l) changed file(s)"
