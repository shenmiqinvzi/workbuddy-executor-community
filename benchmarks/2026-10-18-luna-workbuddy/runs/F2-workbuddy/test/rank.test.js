const test = require('node:test');
const assert = require('node:assert/strict');
const { rank } = require('../src/rank');

test('basic ranking placeholder', () => {
  assert.equal(rank([{ score: 1 }])[0].score, 1);
});

test('sorts numeric scores in descending order', () => {
  const input = [{ score: 3 }, { score: 10 }, { score: -1 }, { score: 7.5 }, { score: 0 }];
  const result = rank(input);

  assert.deepEqual(
    result.map((item) => item.score),
    [10, 7.5, 3, 0, -1]
  );
});

test('keeps equal scores stable (original relative order)', () => {
  const input = [
    { id: 'a', score: 5 },
    { id: 'b', score: 9 },
    { id: 'c', score: 5 },
    { id: 'd', score: 9 },
    { id: 'e', score: 5 },
  ];
  const result = rank(input);

  assert.deepEqual(
    result.map((item) => item.id),
    ['b', 'd', 'a', 'c', 'e']
  );
});

test('places missing scores after numeric scores, preserving their order', () => {
  const input = [
    { id: 'missing-1' },
    { id: 'low', score: 1 },
    { id: 'null', score: null },
    { id: 'high', score: 100 },
    { id: 'nan', score: Number.NaN },
    { id: 'string', score: '42' },
  ];
  const result = rank(input);

  assert.deepEqual(
    result.map((item) => item.id),
    ['high', 'low', 'missing-1', 'null', 'nan', 'string']
  );
  assert.deepEqual(
    result.slice(2).map((item) => item.score),
    [undefined, null, Number.NaN, '42']
  );
});

test('does not mutate the input array or its item order', () => {
  const input = [{ id: 'x', score: 2 }, { id: 'y', score: 8 }, { id: 'z', score: 5 }];
  const snapshot = input.slice();

  const result = rank(input);

  assert.notEqual(result, input, 'rank must return a new array');
  assert.deepEqual(input, snapshot, 'input array order must be unchanged');
  assert.deepEqual(
    input.map((item) => item.id),
    ['x', 'y', 'z']
  );
  assert.deepEqual(
    result.map((item) => item.id),
    ['y', 'z', 'x']
  );
});

test('handles empty arrays and all-missing scores', () => {
  assert.deepEqual(rank([]), []);

  const input = [{ id: 'a' }, { id: 'b' }];
  assert.deepEqual(
    rank(input).map((item) => item.id),
    ['a', 'b']
  );
});
