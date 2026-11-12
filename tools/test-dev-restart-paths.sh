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

# Exercise the Finder entry file from another CWD, with spaces, Unicode and a
# shell metacharacter in its checkout path. The stub never builds or launches.
launcher_fixture="$fixture/checkout space & ü"
mkdir -p "$launcher_fixture/tools"
cp "$root/Launch-CLIHarbor.command" "$launcher_fixture/Launch-CLIHarbor.command"
cat > "$launcher_fixture/tools/dev-restart.sh" <<'HELPER'
#!/usr/bin/env bash
[[ $# == 0 ]] || exit 98
touch "$CLIHARBOR_LAUNCH_TEST_MARKER"
exit "$CLIHARBOR_LAUNCH_TEST_EXIT"
HELPER
chmod +x "$launcher_fixture/Launch-CLIHarbor.command"
for expected in 0 37; do
  rm -f "$fixture/launch-marker"
  result=0
  CLIHARBOR_LAUNCH_TEST_MARKER="$fixture/launch-marker" CLIHARBOR_LAUNCH_TEST_EXIT="$expected" \
    "$launcher_fixture/Launch-CLIHarbor.command" < /dev/null > "$fixture/output" 2>&1 || result=$?
  if [[ "$result" != "$expected" || ! -f "$fixture/launch-marker" ]]; then
    echo 'FAIL: quick launcher did not invoke its own helper or preserve its exit code.' >&2
    exit 1
  fi
  if (( expected != 0 )) && ! grep -q 'CLIHarbor could not start' "$fixture/output"; then
    echo 'FAIL: quick launcher did not explain the failed launch.' >&2
    exit 1
  fi
done
echo 'PASS: quick launcher resolves its own checkout and preserves success/failure.'
