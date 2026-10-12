'use strict';

/** Line-level diff (LCS) rendered as a unified diff, so every save can be previewed. */

function lcsTable(a, b) {
  const n = a.length;
  const m = b.length;
  const width = m + 1;
  const table = new Int32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i * width + j] =
        a[i] === b[j]
          ? table[(i + 1) * width + (j + 1)] + 1
          : Math.max(table[(i + 1) * width + j], table[i * width + (j + 1)]);
    }
  }
  return { table, width };
}

/** @returns {{type: ' '|'-'|'+', text: string}[]} */
function diffLines(a, b) {
  const { table, width } = lcsTable(a, b);
  const out = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ type: ' ', text: a[i] });
      i += 1;
      j += 1;
    } else if (table[(i + 1) * width + j] >= table[i * width + (j + 1)]) {
      out.push({ type: '-', text: a[i] });
      i += 1;
    } else {
      out.push({ type: '+', text: b[j] });
      j += 1;
    }
  }
  while (i < a.length) {
    out.push({ type: '-', text: a[i] });
    i += 1;
  }
  while (j < b.length) {
    out.push({ type: '+', text: b[j] });
    j += 1;
  }
  return out;
}

/**
 * Unified diff with hunks. Returns '' when the two texts are identical.
 */
function unifiedDiff(before, after, options = {}) {
  const context = options.context === undefined ? 3 : options.context;
  const labelA = options.labelA || 'before';
  const labelB = options.labelB || 'after';
  const a = before.split(/\r\n|\n/);
  const b = after.split(/\r\n|\n/);
  const parts = diffLines(a, b);

  const changedIndexes = [];
  for (let i = 0; i < parts.length; i += 1) {
    if (parts[i].type !== ' ') changedIndexes.push(i);
  }
  if (changedIndexes.length === 0) return '';

  const hunks = [];
  let start = Math.max(0, changedIndexes[0] - context);
  let end = Math.min(parts.length - 1, changedIndexes[0] + context);
  for (let k = 1; k < changedIndexes.length; k += 1) {
    const index = changedIndexes[k];
    if (index - context <= end + 1) {
      end = Math.min(parts.length - 1, index + context);
    } else {
      hunks.push([start, end]);
      start = Math.max(0, index - context);
      end = Math.min(parts.length - 1, index + context);
    }
  }
  hunks.push([start, end]);

  const header = [`--- ${labelA}`, `+++ ${labelB}`];
  const body = [];
  for (const [hStart, hEnd] of hunks) {
    let aCount = 0;
    let bCount = 0;
    let aLine = 0;
    let bLine = 0;
    for (let i = 0; i <= hStart; i += 1) {
      if (parts[i] === undefined) continue;
      if (parts[i].type !== '+') aLine += 1;
      if (parts[i].type !== '-') bLine += 1;
    }
    for (let i = hStart; i <= hEnd; i += 1) {
      if (parts[i].type !== '+') aCount += 1;
      if (parts[i].type !== '-') bCount += 1;
    }
    body.push(`@@ -${aLine},${aCount} +${bLine},${bCount} @@`);
    for (let i = hStart; i <= hEnd; i += 1) {
      body.push(`${parts[i].type}${parts[i].text}`);
    }
  }

  return [...header, ...body].join('\n');
}

/** Short human summary: how many lines added / removed. */
function diffStat(before, after) {
  if (before === after) return { added: 0, removed: 0 };
  const parts = diffLines(before.split(/\r\n|\n/), after.split(/\r\n|\n/));
  let added = 0;
  let removed = 0;
  for (const part of parts) {
    if (part.type === '+') added += 1;
    else if (part.type === '-') removed += 1;
  }
  return { added, removed };
}

module.exports = { diffLines, unifiedDiff, diffStat };
