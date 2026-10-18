/**
 * Sort items by numeric `score` in descending order.
 *
 * - Returns a new array; the input array and its items are not mutated.
 * - Ties keep their original relative order (stable).
 * - Items without a usable numeric score (undefined / null / NaN / non-number)
 *   are placed after all numeric-scored items, also in original order.
 *
 * @param {Array<{score?: number}>} items
 * @returns {Array<{score?: number}>}
 */
function rank(items) {
  if (!Array.isArray(items)) {
    throw new TypeError('rank(items) expects an array');
  }

  const hasScore = (item) =>
    item !== null &&
    typeof item === 'object' &&
    typeof item.score === 'number' &&
    Number.isFinite(item.score);

  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const aHas = hasScore(a.item);
      const bHas = hasScore(b.item);

      if (aHas && bHas) {
        if (b.item.score !== a.item.score) {
          return b.item.score - a.item.score;
        }
        return a.index - b.index;
      }
      if (aHas) return -1;
      if (bHas) return 1;
      // Both missing a score: preserve original order.
      return a.index - b.index;
    })
    .map((entry) => entry.item);
}

module.exports = { rank };
