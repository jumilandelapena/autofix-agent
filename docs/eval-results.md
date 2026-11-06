# Eval results

Generated 2026-11-06T14:59:08.472Z · commit `e4fa18a` · provider **anthropic** · model `claude-opus-5-5` · sandbox **docker** · live PRs · target: jumilandelapena/demo-inventory-api

| # | Issue | Reproduced | Fixed | Suite green | Steps | Time | Cost | PR | Outcome |
|---|---|---|---|---|---|---|---|---|---|
| 1 | GET /items?limit=N returns N+1 items | yes | yes | yes | 4 | 33s | $0.0661 | [#15](https://github.com/jumilandelapena/demo-inventory-api/pull/15) | submitted |
| 2 | Discount is subtracted as a dollar amount instead of a percentage | yes | yes | yes | 4 | 31s | $0.0383 | [#17](https://github.com/jumilandelapena/demo-inventory-api/pull/17) | submitted |
| 3 | PUT /items/:id returns the updated item but the change is not persisted | yes | yes | yes | 4 | 35s | $0.0673 | [#19](https://github.com/jumilandelapena/demo-inventory-api/pull/19) | submitted |
| 4 | Search is case-sensitive although it is documented as case-insensitive | yes | yes | yes | 5 | 32s | $0.0380 | [#22](https://github.com/jumilandelapena/demo-inventory-api/pull/22) | submitted |
| 5 | DELETE /items/:id with an unknown id returns 204 and deletes a different item | yes | yes | yes | 4 | 36s | $0.0367 | [#23](https://github.com/jumilandelapena/demo-inventory-api/pull/23) | submitted |
| 6 | slugify leaves a trailing hyphen when the name ends with punctuation | yes | yes | yes | 4 | 31s | $0.0370 | [#24](https://github.com/jumilandelapena/demo-inventory-api/pull/24) | submitted |

**6/6 fixed** · 25 steps · 3.3 min · $0.2834 total · $0.0472 per issue

Columns: *Reproduced* = the agent wrote a test that failed on the base commit. *Fixed* = the harness accepted the submission (repro test passes, no new failures, no existing test weakened, lint clean). *Steps* = model turns (API calls). Cost is computed from `usage` on every turn with the Claude Opus 5.5 price list (cache reads at $0.20/MTok).
