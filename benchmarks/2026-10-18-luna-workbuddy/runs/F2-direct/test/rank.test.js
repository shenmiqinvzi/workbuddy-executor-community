const test = require('node:test');
const assert = require('node:assert/strict');
const { rank } = require('../src/rank');

test('sorts numeric scores descending', () => {
  const result = rank([{ score: 2 }, { score: 9 }, { score: 4 }]);
  assert.deepEqual(result.map(item => item.score), [9, 4, 2]);
});

test('preserves input order for equal scores', () => {
  const first = { id: 'first', score: 5 };
  const second = { id: 'second', score: 5 };
  assert.deepEqual(rank([first, second]), [first, second]);
});

test('places missing scores after numeric scores', () => {
  const missing = { id: 'missing' };
  const low = { id: 'low', score: 1 };
  const high = { id: 'high', score: 3 };
  assert.deepEqual(rank([missing, low, high]), [high, low, missing]);
});

test('returns a new array and leaves input order unchanged', () => {
  const items = [{ score: 1 }, { score: 3 }, { score: 2 }];
  const originalOrder = [...items];
  const result = rank(items);

  assert.notStrictEqual(result, items);
  assert.deepEqual(items, originalOrder);
});
