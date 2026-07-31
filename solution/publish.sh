#!/bin/bash
# Reference solution entrypoint.
#
# This script proves that a CORRECT implementation of
# publisher/release-publisher.mjs makes the task's verifier pass (Proof B,
# reward = 1). It is run inside the built task container, from WORKDIR /app.
#
# It does exactly one thing: it places the reference implementation
# (shipped alongside this script as solution/release-publisher.mjs) at the
# path the candidate is instructed to create it at, then exits. The actual
# `npm run report` execution and grading happens afterwards, driven by
# tests/test.sh / tests/test_outputs.py — the same verifier that will later
# grade real candidates.
#
# IMPORTANT: this script must NEVER be copied into environment/. The
# environment/ tree that ships to candidates must contain no publisher code
# at all (that is what makes the "empty environment -> reward 0" negative
# control meaningful).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

mkdir -p /app/publisher
cp "${SCRIPT_DIR}/release-publisher.mjs" /app/publisher/release-publisher.mjs

echo "solution/publish.sh: reference publisher installed at /app/publisher/release-publisher.mjs"
