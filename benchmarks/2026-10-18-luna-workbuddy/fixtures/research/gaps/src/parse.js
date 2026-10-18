function parseCount(value) {
  const n = Number(value);
  if (!Number.isInteger(n)) throw new TypeError('count must be an integer');
  if (n < 0) throw new RangeError('count must be nonnegative');
  return n;
}
function firstNonEmpty(lines) {
  return lines.find(line => line.trim().length > 0)?.trim() ?? null;
}
module.exports = { parseCount, firstNonEmpty };
