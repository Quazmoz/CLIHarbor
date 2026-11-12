#!/bin/bash
# Finder opens this file in Terminal; the helper builds and opens the full app.
echo 'CLIHarbor: building the full app and opening your browser...'
echo 'Requires the Go, Node.js and npm versions listed in README.md.'
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)" || exit 1
/bin/bash "$root/tools/dev-restart.sh"
launch_exit=$?
if (( launch_exit != 0 )); then
  echo 'CLIHarbor could not start. Review the error above and README.md.' >&2
  if [[ -t 0 ]]; then read -r -p 'Press Return to close this window.'; fi
fi
exit "$launch_exit"
