#!/bin/sh
# Screenshot one window of the QC build (never the whole screen).
#   scripts/qc/shot.sh <out.png> [main|timer]
# main = the wide window, timer = the 400px floating timer.
set -e
out="$1"; want="${2:-main}"
dir=$(cd "$(dirname "$0")" && pwd)
pid=$(pgrep -f "target/debug/boss-timer" | head -1)
[ -n "$pid" ] || { echo "QC build isn't running"; exit 1; }
id=$(osascript -l JavaScript "$dir/wins.js" "$pid" | awk -v want="$want" '
  want == "main"  && $4 > 500             { print $1; exit }
  want == "timer" && $4 <= 500 && $5 > 50 { print $1; exit }')
[ -n "$id" ] || { echo "no $want window on screen:"; osascript -l JavaScript "$dir/wins.js" "$pid"; exit 1; }
screencapture -x -o -l "$id" "$out"
echo "$out"
