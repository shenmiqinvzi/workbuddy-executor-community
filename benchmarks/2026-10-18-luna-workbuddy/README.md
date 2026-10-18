# WorkBuddy executor paired study (GPT-6 Luna)

Status: task texts and fixtures were frozen before execution; the shared checker was amended after S1 output was reported, with the deviation recorded in [the protocol amendment](ledger/protocol-amendment.md). No business workspace or gateway code is used.

This is a six-task, paired, within-task comparison of (A) GPT-6 Luna executing directly and (B) GPT-6 Luna supervising one free WorkBuddy worker. The only permitted WorkBuddy model is `deepseek-v4.1-flash`; each dispatch must be preceded by `list_models` showing that exact ID and `credits: x0.00`, and all dispatch/session continuation calls must explicitly pass it. A mismatch ends the WorkBuddy arm.

## Frozen protocol

- Six tasks, two each in three strata: small local change (S1/S2), bug fix with verification (F1/F2), and documentation/test investigation (R1/R2).
- Each pair gets identical task text, acceptance checks, and clean starter bytes in separate `direct` and `workbuddy` workspaces. Direct and supervised arms must use GPT-6 Luna with the same reasoning setting. Isolated contexts prevent answer transfer.
- Pair order is frozen: S1 direct first; S2 WorkBuddy first; F1 direct first; F2 WorkBuddy first; R1 direct first; R2 WorkBuddy first. Only one WorkBuddy task may be in flight at a time.
- Clock starts immediately before the first execution-condition action (direct invocation or WorkBuddy `list_models`) and ends after final independent acceptance decision. It includes queueing, waiting, handoff, verification, and rework. Record queue/wait/active components only when timestamps support them.
- Codex supervision observations: count each supervisory/acceptance gateway call; record CLI-captured output file byte lengths and whether capture is stdout-only or merged stdout/stderr. These are launcher file bytes, not MCP wire bytes. Record human/Codex active time only if measurable. Tokens and active reasoning seconds are uncollected unless the runtime exposes them; never infer tokens from bytes.
- Record first-pass and final acceptance separately. Rework rounds count only external feedback/continue cycles; worker self-correction stays separate. Record user interventions separately from agent-initiated recovery. Failed and blocked attempts remain in denominator and are not silently replaced.
- Acceptance is binary against frozen observable checks. A task passes only if all listed checks are met and evidence maps to the final workspace state. For investigation tasks, required claims must cite exact source paths/lines and match the fixture contents.
- Results apply only to these six fixtures and this GPT-6 Luna / WorkBuddy pairing; no population-level or token-saving claim.

## Limitations and accounting

Fixture/protocol construction and final cross-run synthesis are preparation/analysis costs outside per-run clocks; disclose their measured time if available. Parent-agent independent review is also outside run clocks. WorkBuddy-native runtime, claim, report and stop evidence must be captured. Any mismatch in actual model identity or reasoning setting invalidates pair-level strict comparability and is disclosed. No gateway/runtime code, account, permissions, policy, MCP registration, or system settings may be changed.

## Frozen run schedule

| Pair | Stratum | First condition | Task |
|---|---|---|---|
| S1 | Small local change | Direct | `tasks/S1.md` |
| S2 | Small local change | WorkBuddy | `tasks/S2.md` |
| F1 | Fix + verification | Direct | `tasks/F1.md` |
| F2 | Fix + verification | WorkBuddy | `tasks/F2.md` |
| R1 | Documentation investigation | Direct | `tasks/R1.md` |
| R2 | Test investigation | WorkBuddy | `tasks/R2.md` |

See `ledger/` for frozen task hashes, evidence, timestamps, and results.

The completed exploratory pilot and its limits are documented in [REPORT.zh-CN.md](REPORT.zh-CN.md); the per-run table is generated with `node tools/summarize-results.mjs`.
