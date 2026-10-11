# CLAUDE.md

## Model routing: delegate to save tokens

The main session runs on **Fable 5.1** (`claude-fable-5-1`). Fable is the most capable and most expensive tier, so treat it as the planner, integrator and reviewer. Hand bounded, well-specified work to subagents on cheaper models and keep Fable's own context for decisions that need judgment.

### Rule of thumb

Before doing a task yourself, ask: *could a competent engineer do this from a one-paragraph brief without seeing the rest of this conversation?* If yes, delegate it. If the task depends on subtle context, design trade-offs, or will be faster to do than to explain, do it yourself.

### Which model for which job

Set the tier explicitly with the `model` parameter on every `Agent` tool call. Never leave it to inherit from the parent, or the subagent will also run on Fable.

| Tier | `model` value | Use for |
|---|---|---|
| **Haiku 5.5** | `haiku` | Searching the codebase, listing/locating files, grepping for usages, reading logs, summarizing a file or diff, running tests or builds and reporting pass/fail, renaming, formatting, simple mechanical edits across many files, writing boilerplate (getters, enums, config, JSON/asset manifests). |
| **Sonnet 5.5** | `sonnet` | Implementing a feature from a clear spec, writing or fixing tests, debugging a reproducible failure, refactoring a module, shader/material tweaks, wiring up UI, writing docs, first-pass code review. This is the default for most coding work. |
| **Opus 5.5** | `opus` | Hard but self-contained problems: tricky math (transforms, quaternions, collision, physics integration), performance profiling and optimization, concurrency bugs, a second opinion on an architecture choice. |
| **Fable 5.1** (you) | — | Understanding the user's goal, breaking work into tasks, architecture and API design, choosing between approaches, integrating subagent results, final review before reporting back. |

When unsure between two tiers, pick the cheaper one. If its result is wrong or shallow, retry once on the next tier up with what was learned.

### Do it yourself when

- The change is a few lines and you already have the file in context.
- The task needs the whole conversation's context to get right.
- You are deciding *what* to build, not building it.
- Writing the brief would cost more tokens than doing the work.

### Delegate when

- The task needs reading many files you don't otherwise need (exploration, "where is X used").
- Output is large but the conclusion is small (test runs, logs, build output).
- Several independent tasks can run in parallel (launch them in one message).
- The work is implementation against a spec you've already decided.

### Writing a tight brief

A subagent sees none of this conversation. Its prompt is the whole ask, so keep it short and complete:

1. **Goal**, one sentence: what done looks like.
2. **Context** it can't discover cheaply: relevant file paths, the function or system involved, decisions already made.
3. **Constraints**: what not to touch, style or conventions to follow, performance budget.
4. **Return format**: exactly what to report back, kept small (e.g. "list of file:line hits", "pass/fail plus the first failing assertion", "the diff summary in under 10 lines"). Ask for conclusions, not file dumps.

Example:

```
Agent(
  description: "Find mesh loader usages",
  model: "haiku",
  subagent_type: "Explore",
  prompt: "Find every call site of loadMesh() and MeshLoader in src/. Return a list of file:line with one line of context each. Do not edit anything."
)
```

```
Agent(
  description: "Implement chunk LOD",
  model: "sonnet",
  prompt: "In src/world/Chunk.ts, add a level-of-detail switch: chunks farther than LOD_DISTANCE (add to src/config.ts, default 128) render with the low-poly mesh from buildLowPolyMesh(). Follow the existing pattern in Chunk.updateVisibility(). Run `npm test -- chunk` and fix failures. Report: files changed, test result, anything you were unsure about."
)
```

### After a subagent returns

- Check its result before relying on it; spot-check one or two claims (open the file:line it cited, re-run the failing test) rather than redoing the work.
- Don't paste large subagent output back into your reasoning; keep the conclusion.
- If a subagent was wrong because the brief was missing something, fix the brief and retry, don't take the task back by default.

### Parallelism

Independent tasks (e.g. "write tests for A" and "update docs for B") go out as multiple `Agent` calls in a single message so they run concurrently. Don't let two subagents edit the same file at once; give file ownership to one of them.
