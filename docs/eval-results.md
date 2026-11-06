# Eval results

Generated 2026-11-06T13:31:40.745Z · commit `8573d22` · provider **mock** · model `claude-opus-5-5 (mock replay)` · sandbox **local** · dry run (no PRs) · target: local demo-repo

> **This table was produced with `LLM_PROVIDER=mock`.** The model turns are replayed from `evals/fixtures/mock`; every tool call, test run and verification step is real, but no tokens were spent, so cost is $0. Re-run `pnpm eval` with `ANTHROPIC_API_KEY` set to replace it with real numbers.

| # | Issue | Reproduced | Fixed | Suite green | Steps | Time | Cost | PR | Outcome |
|---|---|---|---|---|---|---|---|---|---|
| 1 | GET /items?limit=N returns N+1 items | yes | yes | yes | 7 | 26s | $0.0000 | - | submitted |
| 2 | Discount is subtracted as a dollar amount instead of a percentage | yes | yes | yes | 7 | 25s | $0.0000 | - | submitted |
| 3 | PUT /items/:id returns the updated item but the change is not persisted | yes | yes | yes | 7 | 25s | $0.0000 | - | submitted |
| 4 | Search is case-sensitive although it is documented as case-insensitive | yes | yes | yes | 7 | 25s | $0.0000 | - | submitted |
| 5 | DELETE /items/:id with an unknown id returns 204 and deletes a different item | yes | yes | yes | 7 | 25s | $0.0000 | - | submitted |
| 6 | slugify leaves a trailing hyphen when the name ends with punctuation | yes | yes | yes | 6 | 25s | $0.0000 | - | submitted |

**6/6 fixed** · 41 steps · 2.5 min · $0.0000 total · $0.0000 per issue

Columns: *Reproduced* = the agent wrote a test that failed on the base commit. *Fixed* = the harness accepted the submission (repro test passes, no new failures, no existing test weakened, lint clean). *Steps* = model turns (API calls). Cost is computed from `usage` on every turn with the Claude Opus 5.5 price list (cache reads at $0.20/MTok).
