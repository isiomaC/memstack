#!/usr/bin/env bash
set -euo pipefail

summary_file=${GITHUB_STEP_SUMMARY:-/dev/stdout}
{
  echo "## MemStack verification"
  echo
  echo "| Check | Result |"
  echo "| --- | --- |"
  for result in "$@"; do
    name=${result%%=*}
    status=${result#*=}
    echo "| $name | $status |"
  done
} >> "$summary_file"
