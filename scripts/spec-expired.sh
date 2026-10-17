#!/usr/bin/env bash
# Lists spec sections whose "Expires:" date has passed (see CLAUDE.md).
set -euo pipefail
cd "$(dirname "$0")/.."
today=${1:-$(date +%F)}  # optional arg: pretend today is this date
status=0
for f in docs/*.md; do
  heading=""
  while IFS= read -r line; do
    [[ $line =~ ^#{1,4}\  ]] && heading=$line
    if [[ $line =~ Expires:\*?\*?\ *([0-9]{4}-[0-9]{2}-[0-9]{2}) ]]; then
      exp=${BASH_REMATCH[1]}
      if [[ $exp < $today ]]; then
        echo "EXPIRED $exp  $f  $heading"
        status=1
      fi
    fi
  done < "$f"
done
[[ $status -eq 0 ]] && echo "No expired sections."
exit 0
