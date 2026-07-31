# Author Notes — Firmware Release Publisher Task

These notes are for reviewers/graders, not for candidates. They record the
decisions made while authoring this task and how the two open questions
flagged in `completion_plan.yaml` were resolved.

## Open questions — resolved

1. **What counts as a duplicate manifest row?**
   Resolved as: identical across **every** column (`entry_id`, `bundle_id`,
   `component_id`, `version`, `size_bytes`, `record_type`, `supersedes_id`,
   `recorded_at`). Rows sharing only an `entry_id` but differing elsewhere
   are treated as distinct and are both kept. This is stated explicitly in
   `instruction.md` and is the invariant the reference solution implements
   via `SELECT DISTINCT` over all columns.

2. **What is the exact withdrawal rule?**
   Resolved as: a `WITHDRAWAL` row cancels exactly the `BUILD` row whose
   `entry_id` matches the withdrawal's `supersedes_id`. Matching is by
   `entry_id` only (no size/version comparison), and there is no notion of
   partial withdrawal. A bundle with zero surviving `BUILD` rows after this
   filter is dropped entirely rather than published as an empty bundle
   (`BND-104` in the fixture data exercises this path).

## Reference solution structure

- `solution/release-publisher.mjs` — the actual reference implementation.
- `solution/publish.sh` — the harness entrypoint. It copies
  `release-publisher.mjs` into `/app/publisher/release-publisher.mjs` inside
  the built container and exits; it does **not** itself run `npm run report`
  or invoke the verifier. Grading proceeds afterward via `tests/test.sh`.
- `environment/` ships with **no** `publisher/` directory at all. This is
  deliberate: it is what makes the negative control (empty environment ->
  reward 0) meaningful. Do not add any publisher code under `environment/`.

## Verification performed before submission

- **Proof A (negative control):** built the image from `environment/`
  as-is (no publisher present), ran the verifier — `npm run report` fails
  (module not found), and the pytest suite fails accordingly, producing
  reward 0.
- **Proof B (reference solution):** ran `solution/publish.sh` inside the
  built container to install the reference implementation, then ran
  `npm run report`. Output matched `reports/publications.expected.txt`
  exactly except for the randomized `RECEIPT=` field. Re-running produced
  identical `publication_id`/`request_token` values for every bundle
  (idempotency), confirming no duplicate publications are created.

## Known issue flagged upstream

`tests/test_outputs.py` as currently checked into this scaffold does not
correspond to this task — it contains assertions for an unrelated
"RiftArena cartridge-decode" task (room graphs, inventory transitions,
scripted playthrough). This appears to be a scaffolding/template mismatch
introduced upstream of this authoring pass, not something introduced here.
A verifier matching the six `functional_criteria` entries already recorded
in `completion_plan.yaml` (`report_output_matches`,
`withdrawals_and_duplicates_reconciled`,
`bundles_signed_with_current_key_accepted`,
`receipts_and_tokens_persisted_in_duckdb`,
`idempotent_rerun_no_duplicate_publications`,
`revoked_key_signature_rejected`) needs to be written before this task can
be graded end-to-end. Flagged to the reviewer separately; not silently
worked around here.
