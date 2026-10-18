# TEST-GAPS

Three actionable coverage gaps in `src/parse.js` (implementation) vs `test/parse.test.js` (existing tests). All behaviors below were confirmed by running the code; no source or test files were modified.

## Gap 1 — `parseCount`: non-integer numbers never hit the `TypeError` branch

- **Function:** `parseCount` (`src/parse.js:1`)
- **Untested behavior:** the first guard, `if (!Number.isInteger(n)) throw new TypeError(...)`, at `src/parse.js:3`. It is never exercised: the only negative-path test, `test/parse.test.js:5`, passes `-1` and asserts `RangeError`, which is thrown by the *second* guard at `src/parse.js:4`. No test asserts `TypeError` anywhere in `test/parse.test.js`.
- **Confirmed actual behavior:** `parseCount('3.5')` → `TypeError: count must be an integer`; `parseCount(undefined)` → `TypeError` (NaN path).
- **Actionable test:** add `assert.throws(() => parseCount('3.5'), TypeError)` and `assert.throws(() => parseCount(undefined), TypeError)` in `test/parse.test.js`.

## Gap 2 — `parseCount`: blank / null input is silently coerced to `0`

- **Function:** `parseCount` (`src/parse.js:1`)
- **Untested boundary:** the `Number(value)` coercion at `src/parse.js:2` maps `''` and `null` to `0`, which passes the integer check at `src/parse.js:3` and the nonnegative check at `src/parse.js:4`, so the function returns `0` instead of rejecting missing input. The only happy-path test, `test/parse.test.js:4`, covers `'4'`; no test feeds an empty string or `null`.
- **Confirmed actual behavior:** `parseCount('')` → `0`; `parseCount(null)` → `0`.
- **Actionable test:** pin the contract explicitly — either `assert.equal(parseCount(''), 0)` (documenting the coercion) or `assert.throws(() => parseCount(''), TypeError)` if blank input should be rejected. Whichever is chosen, also cover `parseCount(null)`.

## Gap 3 — `firstNonEmpty`: the "nothing found" fallback to `null` is untested

- **Function:** `firstNonEmpty` (`src/parse.js:7`)
- **Untested boundary:** the `?? null` fallback at `src/parse.js:8`, reached when `Array.prototype.find` returns `undefined`. The only test, `test/parse.test.js:6`, supplies `[' ', ' hi ']`, i.e. a hit on the second element, so the `null` branch is never executed.
- **Confirmed actual behavior:** `firstNonEmpty([])` → `null`; `firstNonEmpty(['  ', '\t', ''])` → `null`.
- **Actionable test:** add `assert.equal(firstNonEmpty([]), null)` and `assert.equal(firstNonEmpty(['  ', '\t', '']), null)` in `test/parse.test.js`.
