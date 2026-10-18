# Test gaps

1. **`parseCount` should reject fractional numeric values.** Add a test such as `parseCount(1.5)` and assert `TypeError`. The integer guard is at [`src/parse.js:3`](src/parse.js), while the existing count tests cover only an integer string and a negative integer ([`test/parse.test.js:4-5`](test/parse.test.js)).

2. **`parseCount` should reject text that cannot be converted to a number.** Add a test such as `parseCount('abc')` and assert `TypeError`. Conversion and integer validation occur at [`src/parse.js:2-3`](src/parse.js); the existing count tests use `'4'` and `-1` ([`test/parse.test.js:4-5`](test/parse.test.js)).

3. **`firstNonEmpty` should return `null` when every line is empty or whitespace.** Add tests for both an empty array and whitespace-only lines. The `find` and `null` fallback are at [`src/parse.js:8`](src/parse.js); the existing test checks only a list that contains text ([`test/parse.test.js:6`](test/parse.test.js)).
