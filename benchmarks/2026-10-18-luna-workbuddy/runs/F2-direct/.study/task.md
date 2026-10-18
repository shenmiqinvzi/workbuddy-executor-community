# F2 — bug fix + verification: JavaScript ranking

Fix `rank(items)` in `src/rank.js` to return a new array sorted by numeric `score` descending, stable for equal scores, without mutating the input. Add/update dependency-free Node tests in `test/rank.test.js`. Missing scores sort after numeric scores.

Acceptance: `node --test test/rank.test.js` passes cases for descending values, equal-score stability, missing-score last, and unchanged input order. Report exact command and exit code.
