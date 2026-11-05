---
name: bughunt
description: 'Use when hunting bugs, auditing recent changes, reproducing regressions, or verifying fixes. Require grounded expectations, failing-before evidence, distinct root-cause counting, and end-to-end verification.'
---

# Bughunt: evidence-driven regression hunting

## Purpose and invocation

Find real, user-reachable defects, prove them, and fix them without changing
intended behavior. Optimize for correctness and reproducibility, not a large
finding count or a quick green test run.

This is a portable, skill-style runbook, not an automatically discovered skill
at this location. Give another agent this file and a bounded task:

> Read BUGHUNT.MD and follow its protocol. Audit [feature / change range].
> Mode: [find and fix / report only]. Target: [optional distinct-bug count].
> Preserve [compatibility requirements]. Do not commit or push unless authorized.
> Return reproduced findings, regression evidence, verification results,
> rejected candidates, and remaining limitations.

For skill discovery, an owner can install this document as
`.github/skills/bughunt/SKILL.md` in a `bughunt` directory. Adjust repository
links after moving it. In another repository, replace the OpenDLE-specific
commands and examples with verified equivalents; preserve the evidence gates.
Follow the receiving agent's higher-priority instructions and permissions.

## Non-negotiable rules

- Read the contract and implementation before deciding something is wrong.
- A suspicious line is a **candidate**, not a confirmed bug.
- Establish failing-before evidence before changing production behavior.
- Validate the fixture. A malformed test is not a product defect.
- Assert user-observable behavior, not merely that the new helper was called.
- Count distinct causes, not assertions, test cases, symptoms, or changed files.
- Preserve compatibility tests; do not rewrite expectations just to turn green.
- Fix the shared cause and every affected surface within the requested scope.
- Never hide failures with broad catches, silent defaults, or success-shaped
  fallbacks. Use the repository's error-reporting conventions.
- Protect user projects, unrelated edits, credentials, and running services.
- Report incomplete work honestly. A requested quota never justifies padding.

## 1. Establish scope and baseline

1. Record the request, audit/fix mode, affected feature, baseline commit, and
   explicit exclusions. Check the worktree before editing:

   ```sh
   git status --short
   git rev-parse HEAD
   git --no-pager diff --stat
   ```

2. Read applicable repository instructions, dependency scripts, nearby tests,
   related documentation, and prior findings. Deduplicate against earlier
   hunts, not just against the current batch.
3. If the user reports a play failure in OpenDLE, inspect
   `logs/playtest/` first. Use `playtest_log_list` / `playtest_log_read` when
   available. Record the actual error and triggering operation before guessing.
4. Run the smallest relevant existing tests to establish their baseline.
   Record pre-existing failures separately. Do not call a failure pre-existing
   unless baseline evidence supports that claim.
5. Leave unrelated dirty files alone. Read and integrate existing edits in
   files you must touch; stop for conflicting changes rather than overwriting.

**Gate:** Know what behavior is under investigation and which changes are yours.

## 2. Build a contract and surface map

Trace one user operation through its real path:

```text
editor / inspector / MCP input
  -> defaults and command fields
  -> schema and project validation
  -> runtime state and dispatch
  -> renderer / physics / other observable consumer
  -> persistence, export, reuse, and reload
```

Not every operation uses every layer. List the relevant layers rather than
assuming a runtime-only fix covers the feature.

Establish expected behavior using, in order:

1. The user's explicit requirement and documented compatibility contract.
2. Existing tests and public documentation.
3. Shared helpers, schemas, and analogous operations already in the repository.
4. Verified upstream behavior when upstream compatibility is actually promised.

Distinguish a missing feature or design preference from broken promised behavior.
If sources conflict, investigate; do not invent semantics to manufacture a bug.
For example, OpenDLE spawning an object is not a new layout start. Likewise,
remaining actions in the current rule are allowed to finish after its owner is
removed; later owned rules must not run for that removed owner.

## 3. Generate hypotheses systematically

Use the following matrix to choose high-value tests. Cover meaningful boundaries
and interactions; do not brute-force every Cartesian combination.

| Axis | Cases worth contrasting |
|---|---|
| Cardinality | Zero, one, several; absent selection versus explicitly empty selection |
| Identity | Authored ID, object type, name where supported, self, spawned copy, removed object |
| Scope | Global, owned, for-each, parent, child, following sibling |
| Lifecycle | Before creation, first tick, repeated tick, after removal, after reload |
| Representation | Literal versus expression; authored versus live state; default versus explicit value |
| Runtime mode | Headless versus browser; with versus without real physics |
| Boundaries | Zero, negative, fraction, minimum/maximum, just outside range, angle wrap |
| Persistence | Save/load, clone, scene capture, node install, export/import, resource collision |
| Authoring | Initial defaults, change dependent field, confirm, cancel, undo/redo |
| Concurrency/order | Two instances, two rules, menu transition, follow plus glide, removal mid-rule |

Particularly productive techniques:

- **Asymmetric fixtures:** Give two objects different health, variables, angles,
  or positions. Identical fixtures conceal accidental first-object reads.
- **Temporal probes:** Test a transition and the next tick, not only final state.
  Once flags, timers, cleanup, and animation restarts are temporal behavior.
- **Writer/reader tracing:** Follow a value from the command that writes it to
  the property reader, renderer, collider, and serializer that consume it.
- **Differential tests:** Compare literal/expression paths, single/picked actions,
  headless/physics behavior, and editor/MCP validation where semantics should agree.
- **Metamorphic tests:** Adding an unrelated object must not change another
  object's local assignment; a sibling must retain the parent's selection;
  renaming/remapping must preserve internal references. Verify that the claimed
  invariant is actually part of the contract.
- **Round-trip tests:** Export/import or JSON save/load should preserve defined
  behavior, identity relationships, and persistent state, not runtime handles.
- **Atomicity tests:** Snapshot input, attempt a rejected edit/drop/install, and
  assert that failure leaves the input unchanged.
- **Performance probes:** Instrument expensive calls or measure the required
  threshold with a stated setup. One fast run or a helper-name assertion does
  not prove performance.
- **Bounded generated cases:** Use deterministic seeds when generating inputs;
  shrink a failure to a small fixture and keep that fixture as a regression.

## 4. Prove each candidate before fixing

For every candidate:

1. State the expected result, its source, and the actual observed result.
2. Build the smallest fixture that still goes through the relevant public path.
   Use repository factories and realistic asset/clip/body records.
3. For valid-project behavior, call `validateProject` before execution. If
   directly constructed runtime state is necessary, explain how normal play
   reaches that state. Do not use impossible state as proof.
4. For validation defects, use an otherwise valid project with exactly the
   forbidden input under test. Assert a meaningful rejection and, where needed,
   no partial mutation. Arbitrary invalid input reaching a private function is
   not evidence of a user-facing bug.
5. Add a named regression and run it against the unfixed implementation.
6. Inspect the failure. It must reach the intended assertion and fail for the
   claimed reason, not a missing import, invalid asset, or fixture setup error.
7. Record the baseline commit/worktree context, command, test name, expected
   value, actual value/error, and concise failure output.

Example focused command using an existing OpenDLE regression:

```sh
node --test --test-name-pattern='next 07:' test/instance-hunt-next.test.js
```

Run the new test name/file when creating a new regression. Current historical
regressions should pass; they are examples, not proof of a new finding.

If automation is impractical, capture repeatable manual steps and the observed
failure before patching, then repeat those same steps afterward. Label manual
evidence as manual. A screenshot alone rarely proves a lifecycle or data bug.

**Gate:** A candidate becomes reproduced only after this evidence exists.

## 5. Triage, deduplicate, and keep an evidence ledger

Use a session table or other task-local tracker. Do not create repository note
files unless requested. Suggested fields:

```text
ID | state | title | contract source | trigger | expected/actual
   | baseline evidence | root cause | regression | affected surfaces
   | verification | prior-finding relationship
```

State transitions:

```text
candidate -> reproduced -> fixed -> verified
candidate -> rejected / deferred
```

An unimplemented reproduced issue stays reproduced, not fixed. A written patch
is not verified until its checks pass. Record rejection reasons, especially
invalid fixtures, intended behavior, duplicates, and unsupported assumptions.

Counting policy:

- Several properties failing because of one shared reader omission count once.
- Scene and node variants of one reference-filtering mistake count once.
- A picker missing initial data and a picker failing to refresh can be distinct
  only if independently reproduced and caused by separate broken mechanisms.
- Finishing a previously reported partial fix is a follow-up, not a new root.
- A regression introduced by this hunt must be fixed, not advertised as another
  discovered baseline bug.
- Companion tests strengthen evidence but do not increase the root count.
- Tests, assertions, and confirmed roots are separate totals.

If the target cannot be reached with defensible findings, report the verified
count and remaining leads. Do not widen scope, relabel preferences, or split
one fix into multiple "bugs" merely to hit the target.

## 6. Apply a coherent root-cause fix

1. Read enough surrounding code to understand lifetime, ownership, units,
   defaults, caches, and callers before editing.
2. Reuse the canonical helper/schema where one exists. Prefer a shared fix to
   diverging editor, MCP, runtime, and persistence implementations.
3. Preserve declared types, numeric bounds, identity, and error semantics.
   Reject invalid input at the established boundary.
4. Keep changes surgical. No unrelated refactors, dependency upgrades, relaxed
   validators, disabled tests, or new abstractions without a demonstrated need.
5. Retain the failing regression. Add positive and negative neighbors that
   distinguish the fix from an overbroad workaround.
6. Update directly related documentation when behavior or a contract is clarified.

Useful OpenDLE invariants to test explicitly:

- A missing type selection means all instances; an empty selection means none.
  Children inherit picks, siblings do not inherit each other's narrowing.
- Per-target reads use the target's values; group counts retain group meaning.
- Live player/physics state must not be masked by stale authored entity fields.
- Positions distinguish world Z from elevation; angles distinguish radians from
  degrees; physics velocities use the documented units and axis mapping.
- Temporary picks, body handles, and derived caches do not become save payloads.
  Persistent once/timer/variable state follows the intended instance identity.
- Removing an instance cleans its owned state without touching other instances.
- Portable resources remap internal targets, handle external ones according to
  the format contract, and do not reuse incompatible assets.

## 7. Verify at the right level

### A. Regression and neighboring tests

Run the failing regression after the patch, then combine the affected suites in
one runner invocation. For an instance change, a useful focused set is:

```sh
node --test test/instance-hunt-next.test.js test/instance-bughunt.test.js test/instances.test.js test/camera.test.js test/save-game.test.js
```

Check exact IDs, values, output shapes, untouched instances, and follow-up
ticks. Avoid assertions so weak that a no-op implementation would pass.

### B. Real integration

- For physics changes, exercise real Rapier bodies and dispose them afterward.
  A mocked `teleport` call does not prove that the body and visible pose agree.
- For save/load changes, serialize through `JSON.stringify` / `JSON.parse`,
  restore through the real loader, and continue execution. Deep-cloning memory
  does not test the save format.
- For reuse, instantiate more than once into a destination with colliding IDs
  and resource names; verify internal references point to the correct copy.
- For expressions, verify supported scalar types, errors, empty selections,
  per-instance evaluation, and boundary values on the consuming commands.

See [real physics tests](./test/physics-model.test.js) and
[spawn/save integration examples](./test/instance-hunt-next.test.js).

### C. Browser and UI

Use a temporary project and in-memory store or equivalent isolation. Never
overwrite the user's active project to prove a bug.

- Verify the test server is responsive before opening it.
- Import/execute native browser modules for browser compatibility checks.
- For UI claims, actually open the dialog/inspector and change the fields:
  inspect initial choices, dependent refresh, submission, cancellation, and
  save/reopen behavior as relevant.
- Source extraction, a VM test, or direct module execution can be useful focused
  evidence, but is **not** proof that a visible UI workflow works end to end.
- For rendering, inspect the rendered result. A state flag alone does not prove
  a shader, camera pose, or animation looks correct.
- Record what was actually checked. If browser/native verification is
  unavailable, state that limitation; do not report it as passing.

### D. Final gates

After implementation stabilizes, run the final checks appropriate to the change:

```sh
npm test
npm run check
git --no-pager diff --check
```

In OpenDLE, `npm run check` checks JavaScript syntax; it is not a TypeScript
type-check or proof of runtime correctness. Check editor diagnostics when
available. Inspect the final diff for unrelated edits and missing surfaces.
If code changes after verification, rerun the affected checks; do not reuse a
stale success result.

Documentation-only changes need document/link review and whitespace checks, not
an unrelated full runtime suite. Use existing tooling; install dependencies only
after a manifest change or a real missing-dependency failure.

## 8. Parallel work without losing evidence

Default to direct work. Delegate only a substantial independent surface when
permitted, not a lookup or a single continuous execution trace.

Give each agent: scope, baseline, exclusions, owned files, shared-file rules,
required failing-before evidence, bounded stop condition, and report format.
Use nonoverlapping ownership or isolated worktrees; coordinate shared edits.

While it works, handle independent work rather than duplicating its audit.
Collect its result, deduplicate roots, and run combined tests against the merged
state. Require evidence instead of accepting an unverified bug count. Do not
commit while other agents are still editing the same deliverable.

## 9. Reporting, cleanup, and publication

For each confirmed finding, provide:

```text
ID and short title:
User impact / priority:
Expected behavior and authority:
Minimal trigger and actual failure:
Baseline commit + failing command/test or manual evidence:
Root cause and affected surfaces:
Correction:
Passing verification and compatibility checks:
Limitations / unverified environments:
```

The batch summary must separate:

- Distinct new roots found, fixed, and verified.
- Prior-root follow-ups and regressions introduced/fixed during the hunt.
- Regression/companion test counts and final suite totals.
- Rejected/deferred candidates and unresolved failures.
- Browser, physics, persistence, or export checks actually executed.

Keep detailed logs in task-local storage, retaining only relevant sanitized
evidence. Do not publish credentials or private project contents.
Stop only helper processes you started, using known handles/PIDs; dispose test
resources and clean only specifically identified temporary files.

Commit/push only when authorized. Preserve user edits and inspect staged changes.
In OpenDLE, the user owns [version.ini](./version.ini): never bump it on their
behalf; include their changes when authorized to commit. Before a milestone
commit/push, if it was not raised, remind them once without blocking, per
[workspace instructions](./.github/copilot-instructions.md).
When publishing, verify remote HEAD matches the intended commit and report any
remaining worktree changes. Never claim a push that was not verified.

## Completion checklist

- [ ] Every claimed root has valid failing-before evidence and a grounded oracle.
- [ ] New roots are deduplicated against this batch and previous findings.
- [ ] Fixes preserve intended behavior and cover affected surfaces.
- [ ] Regressions and required integration checks pass on the final code.
- [ ] Syntax/diagnostics and diff checks pass where applicable.
- [ ] Requested threshold is met honestly, or the shortfall is explicit.
- [ ] Reports distinguish verified results from assumptions and limitations.
- [ ] Helpers are stopped; user files and unrelated edits are preserved.
- [ ] Commit/push status is accurate and matches the granted authorization.

## Reference implementations

- [Selection/scope regressions](./test/instance-bughunt.test.js)
- [Runtime, properties, expressions, and persistence](./test/instance-hunt-next.test.js)
- [Authoring defaults and dependent pickers](./test/instance-authoring-bughunt.test.js)
- [Scene/node reuse and atomicity](./test/instance-reuse-bughunt.test.js)
- [Physical integration and units](./test/physics-model.test.js)
- [Visual-scripting contracts](./Docs/visual-scripting.md)
- [Engine architecture and test guidance](./DEVELOPMENT.md)
