import assert from "node:assert/strict";
import test from "node:test";
import { diagnoseNativeFailure } from "../src/native-turn-failure.js";

const observedAt = "2026-10-19T06:44:13.642Z";

test("identifies a native 429 without inventing a retry time", () => {
  const diagnostic = diagnoseNativeFailure("429 too many requests (request-id)", observedAt);
  assert.deepEqual(diagnostic.rateLimit, { kind: "rate_limited", statusCode: 429, observedAt });
  assert.match(diagnostic.message, /rate limited \(HTTP 429\)/);
  assert.match(diagnostic.message, /No retry time was supplied/);
  assert.match(diagnostic.message, /429 too many requests \(request-id\)/);
  assert.match(diagnostic.message, /No automatic resend occurred/);
});

test("reports only an explicit numeric Retry-After value", () => {
  const diagnostic = diagnoseNativeFailure("HTTP 429 Too Many Requests; Retry-After: 45", observedAt, "session:sendMessage");
  assert.equal(diagnostic.rateLimit?.retryAfterSeconds, 45);
  assert.equal(diagnostic.rateLimit?.phase, "session:sendMessage");
  assert.match(diagnostic.message, /during native message submission/);
  assert.match(diagnostic.message, /Retry-After: 45 seconds/);
  const dateHint = diagnoseNativeFailure("429; Retry-After: Wed, 21 Oct 2026 07:28:00 GMT", observedAt);
  assert.equal(dateHint.rateLimit?.retryAfterSeconds, undefined);
  const history = diagnoseNativeFailure("429 too many requests", observedAt, "native_history");
  assert.equal(history.rateLimit?.phase, "native_history");
  assert.match(history.message, /in native turn history/);
  for (const value of ["1.5", "-1", "45 milliseconds", "9007199254740992"]) {
    assert.equal(diagnoseNativeFailure(`429; Retry-After: ${value}`, observedAt).rateLimit?.retryAfterSeconds, undefined);
  }
});

test("does not classify an unrelated native failure as rate limiting", () => {
  const diagnostic = diagnoseNativeFailure("500 internal error while processing item 429", observedAt);
  assert.equal(diagnostic.rateLimit, undefined);
  assert.equal(diagnostic.message, "WorkBuddy native turn failed: 500 internal error while processing item 429. No automatic resend occurred.");
});
