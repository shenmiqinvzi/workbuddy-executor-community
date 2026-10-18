const test = require('node:test');
const assert = require('node:assert/strict');
const { rank } = require('../src/rank');
test('basic ranking placeholder', () => assert.equal(rank([{score: 1}])[0].score, 1));
