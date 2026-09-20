#!/usr/bin/env bash
# Guards for a public repository: no tenant paths, no AWS account ids, no stray .env files.
# A tenant-name pattern list is supplied by CI as $FORBIDDEN_PATTERNS_FILE and never committed.
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"
fail=0
if git ls-files --cached --others --exclude-standard | grep -E '^(config/)?tenants/' ; then echo "tenant path present"; fail=1; fi
if git ls-files --cached --others --exclude-standard | grep -E '(^|/)\.env(\..*)?$' | grep -vE '\.env\.example$' ; then echo "env file present"; fail=1; fi
if git grep --untracked -nE '\b[0-9]{12}\b' -- ':!scripts/check-public.sh' | grep -E 'arn:aws|account' ; then echo "aws account id present"; fail=1; fi
if git grep --untracked -nE 'arn:aws:[a-z0-9-]+:[a-z0-9-]*:[0-9]{12}:' -- ':!scripts/check-public.sh' ; then echo "arn with account present"; fail=1; fi
# ADR-0017: a self-hosted runner on a public repository runs strangers' code; state never lands in a repository.
if git grep --untracked -nE 'runs-on:.*self-hosted' -- '.github/' ; then echo "self-hosted runner in a public repository"; fail=1; fi
if git ls-files --cached --others --exclude-standard | grep -E '\.tfstate(\.|$)' ; then echo "terraform state present"; fail=1; fi
if [ -n "${FORBIDDEN_PATTERNS_FILE:-}" ] && [ -s "$FORBIDDEN_PATTERNS_FILE" ]; then
  patterns="$(grep -vE '^\s*$' "$FORBIDDEN_PATTERNS_FILE" || true)"
  if [ -n "$patterns" ] && git grep --untracked -niE -e "$(printf '%s' "$patterns" | paste -sd'|' -)" -- ':!scripts/check-public.sh' ; then
    echo "forbidden string present"; fail=1
  fi
fi
[ $fail -eq 0 ] && echo "public guards ok"
exit $fail
