# Architecture

autofix-agent is a small SWE-agent: one process on the host drives a
disposable container, calls the Claude Messages API in a hand-written loop,
and lets a deterministic harness, not the model, decide when the work is
done. This document walks through the code in the order a run executes.

```
src/
  cli/        commander entry point, terminal rendering
  run.ts      the pipeline (issue -> sandbox -> baseline -> loop -> verify -> PR)
  github/     issue parsing, Octokit client + offline mock, git on the host, PR body
  sandbox/    Docker + local sandboxes, project detection, test-output parsers
  agent/      tool schemas + executor, system prompt, providers, the loop, limits, pricing
  trajectory/ JSONL logger and the static HTML viewer
sandbox/Dockerfile   the image: git, Node 20, Python 3.11 + uv, Go, ripgrep, user `agent`
demo-repo/           Express + TS API with six planted bugs (issues.json)
evals/               eval runner and mock replay fixtures
```

## 1. Issue

`github/issueRef.ts` accepts `https://github.com/owner/repo/issues/N` (with
query, fragment, trailing slash) or `owner/repo#N`. `github/client.ts` has two
implementations of the same `GitHubApi` interface: `OctokitGitHub` (title,
body, labels, all comments, clone URL, default branch) and `LocalGitHub`,
which reads `issues.json` and writes `pr.md` instead of calling GitHub. The
pipeline does not know which one it has.

## 2. Sandbox

The host clones the repository with simple-git into `runs/<id>/repo`
(`core.autocrlf=false` from the first checkout so the patch round-trips byte
for byte). `sandbox/docker.ts` then:

1. creates a container from `autofix-sandbox:latest` (built from
   `sandbox/Dockerfile` on first use) with `Memory`/`MemorySwap` 4 GB,
   `NanoCpus` 2e9, `PidsLimit` 512, `no-new-privileges`, a trimmed capability
   set and `User: agent`;
2. streams the clone in as a tar (`tar-stream`, every entry owned by uid 1000)
   through `putArchive`; nothing is bind-mounted and no host environment
   variable is passed;
3. starts a wall clock that kills the container after 30 minutes.

Every command runs as `docker exec` with `timeout -k 5 <s> bash -lc <cmd>`
inside the container plus a host-side guard; output is captured through
`modem.demuxStream` and capped at 2 MB. `sandbox/local.ts` implements the
same `Sandbox` interface on a host directory for development and the mock
end-to-end test; it is not isolated and says so.

`sandbox/detect.ts` reads `package.json` / `pyproject.toml` /
`requirements.txt` / `go.mod` to choose install, test and lint commands
(vitest, jest, mocha, pytest, `go test`). The pipeline installs dependencies
while the network is still attached, commits any tracked files the installer
rewrote (`package-lock.json`, `go.sum`, `uv.lock`) inside the sandbox so later
diffs against `HEAD` contain only the agent's work, runs the suite once to
record the baseline, lists the existing test files, then disconnects the
container from every Docker network. From here on the agent cannot reach
anything.

## 3. Tools

`agent/tools.ts` declares seven tools with zod schemas converted to JSON
Schema (numeric bounds stripped, `additionalProperties: false`) and
`strict: true`, so the API guarantees the arguments match. The executor:

- validates every input with `safeParse` before touching the sandbox;
- resolves paths relative to `/workspace` and rejects anything that escapes it;
- checks `bash` and custom test commands against the denylist (`rm -rf /`,
  `git push`, `curl`, `wget`, publish commands, sudo, docker, network tools);
- truncates output to 10,000 characters, keeping the head and the tail;
- turns every failure into `{ content, isError: true }`. Nothing thrown by a
  tool reaches the loop, except the sandbox wall-clock error that ends the run.

`run_tests` parses the reporter output (`sandbox/testParser.ts`) into
`{ passed, failed, skipped, failedTests }` so the model reads one line instead
of a wall of text, and the harness can compare runs.

## 4. Phases are enforced, not requested

The system prompt describes three phases, but the harness tracks them in
`AgentState`:

- **Phase A, reproduce.** The run starts in `reproduce`. When a test run
  (via `run_tests`, or a `bash` command that looks like a test runner) reports
  at least one failure *and* the agent has written a file that looks like a
  test, the state moves to `fix`, the failing output is stored as the
  "before" evidence, and a `[harness]` notice is appended to the next user
  message. If 20 turns pass without that happening the loop stops with
  `not_reproduced`, the pipeline comments on the issue with the commands it
  tried, and no PR is opened.
- **Phase B, fix.** Free-form, within the step and budget caps.
- **Phase C, submit.** `submit` is a tool whose result is decided by
  `verifySubmission`: the phase must be `fix`; the named test file must exist
  and have been written in this run; at least one non-test file must have
  changed; no test file may be deleted; a pre-existing test file may gain
  lines but not lose any (`git diff --numstat`); the full suite is re-run and
  must show no failure that was not already failing in the baseline, and the
  repro test must not be among the failures; the linter must pass if it passed
  before. Any violation is returned as an error result and the model keeps
  working. Only an accepted submission ends the loop.

## 5. The loop (`agent/loop.ts`)

A `while (true)` around `provider.createMessage`. Each iteration:

1. checks the caps: max turns, Phase A turns, budget (computed from `usage`
   with `agent/pricing.ts`), sandbox wall clock;
2. calls the API via `client.messages.stream(...)` + `finalMessage()` with
   `max_tokens: 16000`, `output_config: { effort: "high" }`, no `thinking`
   parameter, no forced `tool_choice`;
3. logs the response, usage and cost; when the prompt passes 150k tokens the
   next call goes through `client.beta.messages.stream` with
   `betas: ["context-management-2025-06-27"]` and
   `context_management: { edits: [{ type: "clear_tool_uses_20250919" }] }`;
4. handles `stop_reason`: `refusal` aborts (the pipeline comments on the
   issue); `max_tokens` answers every `tool_use` with an error result, since
   the input may be truncated, and asks the model to continue; `end_turn`
   without a tool call gets two nudges and then counts as `stalled`;
5. executes every `tool_use` block in order and appends all `tool_result`
   blocks in a single user message, followed by any harness notices.

`agent/provider.ts` keeps exactly two cache breakpoints: the system prompt
and the latest tool result. Every older `cache_control` is stripped before
the request, so the prefix up to the last turn is read from cache
(`cache_read_input_tokens` is logged per turn and shown in the viewer). The
system prompt is built once per run from facts the harness gathered (project
type, commands, baseline counts, file tree), so it never changes between
turns.

`MockProvider` replays `evals/fixtures/mock/issue-<N>.json`. Only the
assistant turns are recorded; every tool call runs for real, so a replay
passes only if the edits still apply and the tests still flip.

## 6. Pull request

After an accepted submission the pipeline runs `git add -A` and
`git diff --cached --binary HEAD` inside the container (dependency and build
folders excluded), writes `fix.patch`, applies it with `git apply --index` to
the host clone, creates `fix/issue-<N>-<slug>` (suffixed if the branch exists),
commits with a Conventional Commits message, pushes with the token in a
one-off `http.extraheader` (never written to `.git/config`), and opens the PR
with Octokit, adding the `ai-generated` label (created if missing). The body
(`github/prBody.ts`) is rendered from recorded facts: root cause and summary
from `submit`, the changed files, the before/after reporter output, steps,
tokens, cache reads, cost, time, `Closes #N`, and a review checklist. A
`--dry-run` stops before the commit and prints the diff; a failed push leaves
`pr.md` in the run directory and says so.

The default branch is never pushed to: `commitAndPush` refuses `main`,
`master` and the base branch outright.

## 7. Trajectory

`trajectory/logger.ts` appends one JSON line per event
(`run_start`, `sandbox`, `baseline`, `api_request`, `api_response`,
`tool_call`, `tool_result`, `phase`, `verification`, `limit`, `run_end`).
`trajectory.html` is copied next to it; it fetches `trajectory.jsonl` when
served over http and otherwise accepts a dropped file, and renders each turn
with the model's text, every tool call, a collapsible result, a line diff for
`edit_file`/`write_file`, phase markers, verification results and per-turn
token/cost figures.

## Failure modes and what happens

| Situation | Result |
|---|---|
| Issue cannot be reproduced in 20 turns | comment on the issue with the commands tried; no PR |
| Model refuses | run aborts; comment on the issue |
| Step cap, budget cap or 30-minute wall clock | run stops with a report; patch kept in `runs/<id>/fix.patch` |
| Suite regresses after the fix | `submit` rejected with the new failures; model continues |
| Existing test weakened or deleted | `submit` rejected; model must revert |
| Push not permitted | `pr.md` written, printed in the summary |
| Tool throws | error result to the model, run continues |
