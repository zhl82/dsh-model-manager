'use strict';

/** Deep structural equality for JSON-ish config data. */
function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  if (typeof a === 'object') {
    const ka = Object.keys(a).sort();
    const kb = Object.keys(b).sort();
    if (ka.length !== kb.length) return false;
    for (let i = 0; i < ka.length; i += 1) if (ka[i] !== kb[i]) return false;
    for (const k of ka) if (!deepEqual(a[k], b[k])) return false;
    return true;
  }
  return false;
}

function deepClone(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(deepClone);
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = deepClone(v);
  return out;
}

/** Words a YAML 1.2 core-schema parser would read as non-string scalars. */
const RESERVED_PLAIN = /^(?:~|null|Null|NULL|true|True|TRUE|false|False|FALSE|yes|no|on|off|\d+(?:\.\d+)?)$/;
const SAFE_PLAIN = /^[A-Za-z0-9_][A-Za-z0-9_\-./]*$/;

/** Render a scalar the way the existing config does: plain when unambiguous, quoted otherwise. */
function yamlScalar(value) {
  if (value === null) return 'null';
  const text = String(value);
  if (text.length > 0 && SAFE_PLAIN.test(text) && !RESERVED_PLAIN.test(text)) return text;
  return JSON.stringify(text);
}

/** Strip one layer of YAML quoting from an inline scalar value. */
function unquoteScalar(raw) {
  const text = raw.trim();
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    try {
      return JSON.parse(text);
    } catch {
      return text.slice(1, -1);
    }
  }
  if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) {
    return text.slice(1, -1).replace(/''/g, "'");
  }
  return text;
}

function formatTimestamp(date = new Date()) {
  const pad = (n, width = 2) => String(n).padStart(width, '0');
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}` +
    `-${pad(date.getMilliseconds(), 3)}`
  );
}

module.exports = { deepEqual, deepClone, yamlScalar, unquoteScalar, formatTimestamp };
