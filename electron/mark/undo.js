// One shared undo stack — the Node port of core/undo.py.
//
// Actions act immediately and hand back how to reverse themselves:
//
//     const old = await getVolume();
//     await setVolume(next);
//     ctx.undo.push(`volume → ${next}%`, () => setVolume(old));
//
// Only the action knows that the reverse of "move A to B" is "move B to A";
// what is central is the stack, its ordering and the tool the model calls.

const MAX_DEPTH = 10;
const stack = [];

/** Record that `label` happened and `undoFn()` reverses it. Never throws. */
function push(label, undoFn) {
  if (typeof undoFn !== 'function') return;
  stack.push({ label: String(label).slice(0, 120), undo: undoFn, at: Date.now() });
  while (stack.length > MAX_DEPTH) stack.shift();
}

const canUndo = () => stack.length > 0;
const peek = () => (stack.length ? stack[stack.length - 1].label : '');
/** Most recent first. */
const history = () => stack.map((e) => e.label).reverse();

/**
 * Reverse the most recent operation. Popped before running, so a failing undo
 * cannot be retried forever against a world that has moved on.
 */
async function undoLast() {
  const entry = stack.pop();
  if (!entry) {
    return (
      'There is nothing to undo. I only track things I changed myself — ' +
      'files I moved or wrote, and settings I adjusted.'
    );
  }
  try {
    const detail = (await entry.undo()) || '';
    return `Undone: ${entry.label}.${detail ? ` ${detail}` : ''}`;
  } catch (e) {
    return `Could not undo '${entry.label}': ${e?.message || e}`;
  }
}

function clear() {
  stack.length = 0;
}

module.exports = { MAX_DEPTH, push, canUndo, peek, history, undoLast, clear };
