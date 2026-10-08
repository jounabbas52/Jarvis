// A faithful port of the two pieces of Python's difflib that Mark relies on:
// SequenceMatcher.ratio() (Ratcliff/Obershelp) and get_close_matches().
// Kept exact so a misspelled action resolves to the same name it did in Mark.
// Helper module (leading underscore): never loaded as a tool.

/** Longest common block of a[alo:ahi] and b[blo:bhi], difflib-style (earliest on ties). */
function longestMatch(a, b, alo, ahi, blo, bhi, b2j) {
  let besti = alo;
  let bestj = blo;
  let bestsize = 0;
  let j2len = new Map();
  for (let i = alo; i < ahi; i++) {
    const next = new Map();
    for (const j of b2j.get(a[i]) || []) {
      if (j < blo) continue;
      if (j >= bhi) break;
      const k = (j2len.get(j - 1) || 0) + 1;
      next.set(j, k);
      if (k > bestsize) {
        besti = i - k + 1;
        bestj = j - k + 1;
        bestsize = k;
      }
    }
    j2len = next;
  }
  return [besti, bestj, bestsize];
}

function matchingCount(a, b) {
  const b2j = new Map();
  for (let j = 0; j < b.length; j++) {
    if (!b2j.has(b[j])) b2j.set(b[j], []);
    b2j.get(b[j]).push(j);
  }
  let total = 0;
  const queue = [[0, a.length, 0, b.length]];
  while (queue.length) {
    const [alo, ahi, blo, bhi] = queue.pop();
    const [i, j, k] = longestMatch(a, b, alo, ahi, blo, bhi, b2j);
    if (k) {
      total += k;
      if (alo < i && blo < j) queue.push([alo, i, blo, j]);
      if (i + k < ahi && j + k < bhi) queue.push([i + k, ahi, j + k, bhi]);
    }
  }
  return total;
}

/** SequenceMatcher(None, a, b).ratio() */
function ratio(a, b) {
  const len = a.length + b.length;
  return len ? (2 * matchingCount(a, b)) / len : 1;
}

/** difflib.get_close_matches(word, possibilities, n, cutoff) */
function getCloseMatches(word, possibilities, n = 3, cutoff = 0.6) {
  const scored = [];
  for (const x of possibilities) {
    const r = ratio(x, word);
    if (r >= cutoff) scored.push([r, x]);
  }
  // heapq.nlargest on (score, string): ties go to the lexically larger string.
  scored.sort((p, q) => q[0] - p[0] || (q[1] > p[1] ? 1 : q[1] < p[1] ? -1 : 0));
  return scored.slice(0, n).map((s) => s[1]);
}

module.exports = { ratio, getCloseMatches };
