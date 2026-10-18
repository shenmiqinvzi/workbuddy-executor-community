function rank(items) {
  return items.sort((a, b) => a.score - b.score);
}
module.exports = { rank };
