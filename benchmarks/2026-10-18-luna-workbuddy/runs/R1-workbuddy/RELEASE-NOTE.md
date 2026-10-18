# Release Note

Summary of changes recorded in `notes/`. Items below reflect only what the notes state; no release date or release status is asserted.

- **API — retry on transient failures:** The client now retries idempotent GET requests once after a transient 503 response. (`notes/api.md`)
- **Operations — build provenance:** The container image build now records its source revision as an OCI label, improving traceability of built images. (`notes/ops.md`)
- **UI — save confirmation:** The settings page now shows a saved indicator after successful profile updates. (`notes/ui.md`)

## Uncertainty

- The notes do not establish a release date or a release status. `notes/ops.md` explicitly states that no rollout date is recorded, so this note makes no timing claim.
