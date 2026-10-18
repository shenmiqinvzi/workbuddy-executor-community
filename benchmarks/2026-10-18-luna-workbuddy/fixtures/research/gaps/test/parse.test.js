const test = require('node:test');
const assert = require('node:assert/strict');
const { parseCount, firstNonEmpty } = require('../src/parse');
test('parseCount accepts integer strings', () => assert.equal(parseCount('4'), 4));
test('parseCount rejects negative counts', () => assert.throws(() => parseCount(-1), RangeError));
test('firstNonEmpty trims and finds text', () => assert.equal(firstNonEmpty([' ', ' hi ']), 'hi'));
