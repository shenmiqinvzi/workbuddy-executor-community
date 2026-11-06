import { AdmissionError } from "./collaboration.js";
import type { AutomationService } from "./automation.js";

/**
 * Read-only HTTP projection of the saved automation policy (D5-03 visibility).
 *
 * There is deliberately no POST/PUT/DELETE here. Saving, revising, revoking and dispatching an
 * automatic decision are trusted local operations (`scripts/automation.mjs`); the browser can only
 * look. `WorkbenchHttp` still needs the route list added to its own `isKnownPath` so a non-GET
 * request is answered 405 instead of 404 — see the integration request in HANDOFF.json.
 */
export const AUTOMATION_PATH = "/workbench/v1/automation";

export interface AutomationResponse {
  status: number;
  body: unknown;
}

const STATUS: Record<string, number> = {
  POLICY_MISSING: 404,
  DECISION_NOT_FOUND: 404,
  POLICY_AMBIGUOUS: 409,
  POLICY_REVOKED: 409,
  POLICY_EXPIRED: 409,
  STALE_REVISION: 409,
  AUTOMATION_NOT_ENABLED: 403,
  AUTOMATION_NOT_ARMED: 403,
  AUTOMATION_SCHEMA_UNSUPPORTED: 503,
  INVALID_AUTOMATION: 400,
};

/** Every public path under the prefix, for the shell's method-not-allowed table. */
export function automationPaths(): string[] {
  return [
    AUTOMATION_PATH,
    `${AUTOMATION_PATH}/policies`,
    `${AUTOMATION_PATH}/policies/:policyId`,
    `${AUTOMATION_PATH}/decisions`,
    `${AUTOMATION_PATH}/decisions/:decisionId`,
    `${AUTOMATION_PATH}/audit`,
  ];
}

export function handleAutomationRequest(service: AutomationService | undefined, pathname: string, search: string): AutomationResponse | null {
  if (!service || (pathname !== AUTOMATION_PATH && !pathname.startsWith(`${AUTOMATION_PATH}/`))) return null;
  const url = new URLSearchParams(search ?? "");
  const limit = Math.max(1, Math.min(200, Number(url.get("limit") ?? 50) || 50));
  const rest = pathname.slice(AUTOMATION_PATH.length).replace(/^\/+|\/+$/g, "");
  const parts = rest ? rest.split("/") : [];
  try {
    if (parts.length === 0) return { status: 200, body: { ...service.snapshot(), readOnly: true, snapshotOnly: true } };
    if (parts[0] === "policies") {
      if (parts.length === 1) return { status: 200, body: { readOnly: true, policies: service.listPolicies(limit) } };
      if (parts.length === 2) {
        const policyId = decodeURIComponent(parts[1] ?? "");
        const record = service.getPolicy(policyId);
        return { status: 200, body: { readOnly: true, policy: record.policy, status: record.status, current: record.current, revisions: service.listPolicyRevisions(policyId) } };
      }
      return { status: 404, body: { error: { code: "NOT_FOUND" } } };
    }
    if (parts[0] === "decisions") {
      if (parts.length === 1) return { status: 200, body: { readOnly: true, decisions: service.listDecisions(limit) } };
      if (parts.length === 2) {
        const decision = service.getDecision(decodeURIComponent(parts[1] ?? ""));
        return { status: 200, body: { readOnly: true, decision } };
      }
      return { status: 404, body: { error: { code: "NOT_FOUND" } } };
    }
    if (parts[0] === "audit" && parts.length === 1) return { status: 200, body: { readOnly: true, audit: service.audit(limit) } };
    return { status: 404, body: { error: { code: "NOT_FOUND" } } };
  } catch (error) {
    if (error instanceof AdmissionError) {
      return { status: STATUS[error.code] ?? 400, body: { error: { code: error.code, message: error.message, retryable: false } } };
    }
    const code = (error as NodeJS.ErrnoException)?.code;
    if (typeof code === "string" && /^resource_storage_missing/.test(code)) {
      return { status: 503, body: { error: { code: "STORE_UNAVAILABLE", message: "The automation store is not initialized.", retryable: true } } };
    }
    return { status: 500, body: { error: { code: "AUTOMATION_READ_FAILED", message: "The automation projection could not be read.", retryable: false } } };
  }
}
