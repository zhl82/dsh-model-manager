'use strict';

const { deepEqual } = require('./util');

/**
 * Safety net for text-level editing: everything outside the edited line ranges
 * must be byte-identical to the original file. Combined with the semantic
 * re-parse check, a bad splice can never reach disk.
 *
 * @returns {string[]} errors (empty when the pre-image invariant holds)
 */
function verifyPreimage(originalLines, nextLines, ops) {
  const errors = [];
  const ordered = [...ops].sort((a, b) => a.start - b.start || a.end - b.end);
  let origCursor = 0;
  let nextCursor = 0;

  for (const op of ordered) {
    if (op.start < origCursor) {
      errors.push(`编辑区间重叠：#${op.start}-${op.end}（${op.note || ''}）`);
      continue;
    }
    const untouched = op.start - origCursor;
    for (let k = 0; k < untouched; k += 1) {
      if (originalLines[origCursor + k] !== nextLines[nextCursor + k]) {
        errors.push(
          `编辑区间外第 ${origCursor + k + 1} 行被意外改动（${op.note || ''}）\n` +
            `  原: ${JSON.stringify(originalLines[origCursor + k])}\n` +
            `  新: ${JSON.stringify(nextLines[nextCursor + k])}`,
        );
        break;
      }
    }
    origCursor = op.end;
    nextCursor += untouched + op.lines.length;
  }

  const tailOrig = originalLines.length - origCursor;
  const tailNext = nextLines.length - nextCursor;
  if (tailOrig !== tailNext) {
    errors.push(`文件尾部行数不一致：原 ${tailOrig} 行，新 ${tailNext} 行`);
  } else {
    for (let k = 0; k < tailOrig; k += 1) {
      if (originalLines[origCursor + k] !== nextLines[nextCursor + k]) {
        errors.push(`文件尾部第 ${origCursor + k + 1} 行被意外改动`);
        break;
      }
    }
  }

  return errors;
}

/** Flatten a deep comparison into readable path entries. */
function describeDiff(expected, actual, path = '$', out = [], limit = 12) {
  if (out.length >= limit) return out;
  if (deepEqual(expected, actual)) return out;
  const bothObjects =
    expected && actual && typeof expected === 'object' && typeof actual === 'object' &&
    !Array.isArray(expected) && !Array.isArray(actual);
  if (bothObjects) {
    const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
    for (const key of keys) {
      describeDiff(expected[key], actual[key], `${path}.${key}`, out, limit);
      if (out.length >= limit) break;
    }
    return out;
  }
  out.push(
    `${path}: 期望 ${JSON.stringify(expected) ?? 'undefined'}，实际 ${JSON.stringify(actual) ?? 'undefined'}`,
  );
  return out;
}

module.exports = { verifyPreimage, describeDiff };
