#!/usr/bin/env bash
# Restart only the CLIHarbor development instance previously launched by this helper.
# Never clears browser profiles, OS keyrings, or CyberArk/Conjur state.
set -euo pipefail
umask 077

usage() {
  echo 'Usage: bash tools/dev-restart.sh [--pull | --stop]' >&2
  exit 2
}
mode="${1:-restart}"
[[ $# -le 1 ]] || usage
case "$mode" in restart|--pull|--stop) ;; *) usage ;; esac

root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd -- "$root"
bin="$root/bin"
exe="$bin/cliharbor"
pid_file="$bin/.cliharbor-dev.pid"
log_file="$bin/.cliharbor-dev.log"
[[ ! -L "$bin" ]] || { echo 'Refusing symlinked bin directory.' >&2; exit 1; }
mkdir -p -- "$bin"

proc_start() {
  LC_ALL=C ps -p "$1" -o lstart= 2>/dev/null | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//'
}

stop_owned() {
  [[ -e "$pid_file" || -L "$pid_file" ]] || return 0
  [[ -f "$pid_file" && ! -L "$pid_file" ]] || { echo 'Unsafe PID marker; refusing to stop any process.' >&2; exit 1; }
  local record owned_pid owned_start actual_start command
  record="$(cat -- "$pid_file")"
  if [[ ! "$record" =~ ^([0-9]+)\|(.+)$ ]]; then
    echo 'Invalid CLIHarbor development PID marker; refusing to stop any process.' >&2
    exit 1
  fi
  owned_pid="${BASH_REMATCH[1]}"
  owned_start="${BASH_REMATCH[2]}"
  if ! kill -0 "$owned_pid" 2>/dev/null; then
    rm -- "$pid_file"
    return 0
  fi
  actual_start="$(proc_start "$owned_pid")"
  command="$(ps -p "$owned_pid" -o command= 2>/dev/null || true)"
  if [[ "$actual_start" != "$owned_start" || "$command" != "$exe serve --no-auto-setup"* ]]; then
    echo "PID $owned_pid does not match helper-owned CLIHarbor. Refusing to kill it." >&2
    exit 1
  fi
  echo "Stopping helper-owned CLIHarbor (PID $owned_pid)..."
  kill -TERM "$owned_pid"
  for ((i=0; i<50; i++)); do
    if ! kill -0 "$owned_pid" 2>/dev/null; then
      rm -- "$pid_file"
      return 0
    fi
    sleep 0.1
  done
  echo 'CLIHarbor did not exit after SIGTERM. Stop it manually; no force-kill was attempted.' >&2
  exit 1
}

if [[ "$mode" == '--pull' ]]; then
  git pull --ff-only
fi
stop_owned
if [[ "$mode" == '--stop' ]]; then
  echo 'Helper-owned CLIHarbor stopped (if one was running).'
  exit 0
fi

# Builds and tests Vite assets, replaces stale embedded files, then builds
# exactly the executable this helper will launch. No old web/dist is reused.
go run ./tools/task build
[[ -x "$exe" ]] || { echo 'CLIHarbor build did not create an executable.' >&2; exit 1; }
[[ ! -L "$log_file" && ! -L "$pid_file" ]] || { echo 'Unsafe development log or PID path.' >&2; exit 1; }
: > "$log_file"
nohup "$exe" serve --no-auto-setup > "$log_file" 2>&1 < /dev/null &
owned_pid=$!
owned_start="$(proc_start "$owned_pid")"
if [[ -z "$owned_start" ]]; then
  echo 'Failed to inspect the newly launched CLIHarbor process.' >&2
  exit 1
fi
printf '%s|%s\n' "$owned_pid" "$owned_start" > "$pid_file"

# Observe startup output rather than treating an arbitrary delay as readiness.
for ((i=0; i<150; i++)); do
  if grep -qE '^(Local runtime: http://127\.0\.0\.1:|Default browser launch failed\.)' "$log_file"; then
    echo "Fresh CLIHarbor started (PID $owned_pid)."
    echo "Startup log (private; may contain a one-time bootstrap URL): $log_file"
    echo 'Use the newly opened browser tab; old tabs may refer to a stopped loopback port.'
    exit 0
  fi
  if ! kill -0 "$owned_pid" 2>/dev/null; then
    rm -f -- "$pid_file"
    echo "CLIHarbor exited during startup. Inspect the private log: $log_file" >&2
    exit 1
  fi
  sleep 0.1
done
echo "CLIHarbor started (PID $owned_pid) but readiness was not confirmed. Inspect $log_file" >&2
exit 1
