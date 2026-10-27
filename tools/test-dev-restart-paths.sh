#!/usr/bin/env bash
# Hermetic failure check: no build, application launch or process stop.
set -euo pipefail
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
fixture="$(mktemp -d)"
trap 'rm -rf -- "$fixture"' EXIT
mkdir -p "$fixture/tools" "$fixture/bin" "$fixture/fake-bin" "$fixture/elsewhere"
cp "$root/tools/dev-restart.sh" "$fixture/tools/dev-restart.sh"
printf '%s\n' 'invalid-marker-must-survive' > "$fixture/bin/.cliharbor-dev.pid"
cat > "$fixture/fake-bin/go" <<'GO'
#!/usr/bin/env bash
touch "$CLIHARBOR_RESTART_TEST_BUILD_MARKER"
echo 'simulated build failure' >&2
exit 23
GO
chmod +x "$fixture/fake-bin/go"
cd "$fixture/elsewhere"
result=0
PATH="$fixture/fake-bin:$PATH" CLIHARBOR_RESTART_TEST_BUILD_MARKER="$fixture/built" \
  bash "$fixture/tools/dev-restart.sh" > "$fixture/output" 2>&1 || result=$?
if [[ "$result" != 23 || ! -f "$fixture/built" ]]; then
  echo 'FAIL: build did not fail before process ownership handling.' >&2
  exit 1
fi
if [[ "$(cat "$fixture/bin/.cliharbor-dev.pid")" != 'invalid-marker-must-survive' || -e "$fixture/bin/.cliharbor-dev.log" ]]; then
  echo 'FAIL: failed build changed the instance marker or startup log.' >&2
  exit 1
fi
echo 'PASS: failed build preserves the existing instance marker and does not launch.'

# A pull must run the freshly checked-out helper, as the Windows helper does.
cat > "$fixture/fake-bin/git" <<'GIT'
#!/usr/bin/env bash
if [[ "$*" != 'pull --ff-only' ]]; then exit 99; fi
cat > "$CLIHARBOR_RESTART_TEST_HELPER" <<'UPDATED'
#!/usr/bin/env bash
touch "$CLIHARBOR_RESTART_TEST_FRESH_MARKER"
exit 42
UPDATED
GIT
chmod +x "$fixture/fake-bin/git"
result=0
PATH="$fixture/fake-bin:$PATH" CLIHARBOR_RESTART_TEST_HELPER="$fixture/tools/dev-restart.sh" \
  CLIHARBOR_RESTART_TEST_FRESH_MARKER="$fixture/fresh" CLIHARBOR_RESTART_TEST_BUILD_MARKER="$fixture/built" \
  bash "$fixture/tools/dev-restart.sh" --pull > "$fixture/output" 2>&1 || result=$?
if [[ "$result" != 42 || ! -f "$fixture/fresh" ]]; then
  echo 'FAIL: pull continued with the stale parsed helper.' >&2
  exit 1
fi
echo 'PASS: pull hands off to the updated helper.'
