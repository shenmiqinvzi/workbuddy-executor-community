function rank(items) {
  return [...items].sort((a, b) => {
    const aHasScore = typeof a.score === 'number';
    const bHasScore = typeof b.score === 'number';

    if (!aHasScore && !bHasScore) return 0;
    if (!aHasScore) return 1;
    if (!bHasScore) return -1;
    return b.score - a.score;
  });
}

module.exports = { rank };
