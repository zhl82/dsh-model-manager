'use strict';

/**
 * Surgical YAML editor for DSH profile configs.
 *
 * Design contract: this module only ever rewrites the exact line ranges of the
 * fields it was asked to change. Everything else in the file (comments, key
 * order, quoting style, flow/block style) survives byte-for-byte. Before a
 * change is accepted, the caller compares the re-parsed document against an
 * independently computed expectation, so a text-level bug can never be written.
 */

const { deepClone, yamlScalar, unquoteScalar } = require('./util');

/** Thinking levels DSH accepts, in escalation order. */
const LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const INPUT_MODES = ['inherit', 'text', 'text+image'];
const REASONING_MODES = ['inherit', 'false', 'levels'];
/** The protocol whose compat block offers the supportsReasoningEffort switch. */
const EFFORT_PROTOCOL = 'openai-completions';
const EFFORT_SWITCH = 'supportsReasoningEffort';

class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

// ---------------------------------------------------------------- line helpers

function splitLines(text) {
  return text.split(/\r\n|\n/);
}

function detectEol(text) {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

function indentOf(line) {
  const m = /^([ \t]*)/.exec(line);
  return m[1].length;
}

function isBlank(line) {
  return /^[ \t]*$/.test(line);
}

function isComment(line) {
  return /^[ \t]*#/.test(line);
}

/** Parse `key: value`, `- key: value` or `- value` style lines. */
function mapKeyOf(line) {
  const m = /^([ \t]*)(-)?[ \t]*([A-Za-z0-9_."'\-/[\]]+)[ \t]*:([\s\S]*)$/.exec(line);
  if (!m) return null;
  return {
    indent: m[1].length,
    isItem: Boolean(m[2]),
    key: unquoteScalar(m[3]),
    raw: (m[4] || '').trim(),
    value: unquoteScalar(m[4] || ''),
    inline: (m[4] || '').trim().length > 0,
  };
}

function isDashItem(line) {
  return /^[ \t]*-([ \t]|$)/.test(line);
}

/** First index in [from, to) whose mapping key matches; `indent: null` accepts any. */
function findKeyLine(lines, from, to, key, indent = null) {
  for (let i = from; i < to; i += 1) {
    const mk = mapKeyOf(lines[i]);
    if (!mk || mk.isItem) continue;
    if (mk.key !== key) continue;
    if (indent !== null && mk.indent !== indent) continue;
    return i;
  }
  return -1;
}

/** End (exclusive) of the value block that starts on `keyLine`. */
function blockEndAfter(lines, keyLine, limit) {
  const indent = indentOf(lines[keyLine]);
  for (let i = keyLine + 1; i < limit; i += 1) {
    if (isBlank(lines[i])) return i;
    if (indentOf(lines[i]) <= indent) return i;
  }
  return limit;
}

/** End (exclusive) of one list item's own lines. */
function itemEndAfter(lines, itemLine, limit, itemIndent) {
  for (let i = itemLine + 1; i < limit; i += 1) {
    if (isBlank(lines[i])) return i;
    if (indentOf(lines[i]) <= itemIndent) return i;
  }
  return limit;
}

// --------------------------------------------------------------------- scanning

/**
 * Locate the llm-pi-ai loader entry, its providers, and every model's line range.
 * @returns {{lines: string[], eol: string, entry: object|null, providers: object[], errors: string[]}}
 */
function scan(text) {
  const lines = splitLines(text);
  const result = { lines, eol: detectEol(text), entry: null, providers: [], errors: [] };

  let entryStart = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const mk = mapKeyOf(lines[i]);
    if (mk && mk.isItem && mk.indent === 0 && mk.key === 'id' && mk.value === 'llm-pi-ai') {
      entryStart = i;
      break;
    }
  }
  if (entryStart === -1) {
    result.errors.push('未找到顶层 `- id: llm-pi-ai` 条目');
    return result;
  }

  let entryEnd = lines.length;
  for (let i = entryStart + 1; i < lines.length; i += 1) {
    if (isBlank(lines[i])) continue;
    if (indentOf(lines[i]) === 0 && isDashItem(lines[i])) {
      entryEnd = i;
      break;
    }
  }
  result.entry = { start: entryStart, end: entryEnd };

  const providersLine = findKeyLine(lines, entryStart + 1, entryEnd, 'providers');
  if (providersLine === -1) {
    result.errors.push('llm-pi-ai 条目下未找到 providers');
    return result;
  }

  let keyIndent = null;
  for (let i = providersLine + 1; i < entryEnd; i += 1) {
    if (isBlank(lines[i]) || isComment(lines[i])) continue;
    keyIndent = indentOf(lines[i]);
    break;
  }
  if (keyIndent === null) return result;

  const providerStarts = [];
  for (let i = providersLine + 1; i < entryEnd; i += 1) {
    if (isBlank(lines[i]) || isComment(lines[i])) continue;
    if (indentOf(lines[i]) !== keyIndent) continue;
    const mk = mapKeyOf(lines[i]);
    if (!mk || mk.isItem) continue;
    providerStarts.push(i);
  }

  for (let p = 0; p < providerStarts.length; p += 1) {
    const keyLine = providerStarts[p];
    const blockEnd = p + 1 < providerStarts.length ? providerStarts[p + 1] : entryEnd;
    const providerKey = mapKeyOf(lines[keyLine]).key;

    let fieldIndent = keyIndent + 2;
    for (let i = keyLine + 1; i < blockEnd; i += 1) {
      if (isBlank(lines[i]) || isComment(lines[i])) continue;
      fieldIndent = indentOf(lines[i]);
      break;
    }

    const provider = {
      id: providerKey,
      keyLine,
      blockEnd,
      fieldIndent,
      modelsLine: -1,
      listIndent: null,
      fieldIndentOfModel: null,
      compatLine: -1,
      models: [],
    };

    const modelsLine = findKeyLine(lines, keyLine + 1, blockEnd, 'models');
    provider.modelsLine = modelsLine;
    if (modelsLine !== -1) {
      let listIndent = null;
      for (let i = modelsLine + 1; i < blockEnd; i += 1) {
        if (isBlank(lines[i]) || isComment(lines[i])) continue;
        listIndent = indentOf(lines[i]);
        break;
      }
      provider.listIndent = listIndent;
      if (listIndent !== null) {
        let modelFieldIndent = null;
        for (let i = modelsLine + 1; i < blockEnd; i += 1) {
          if (isBlank(lines[i]) || isComment(lines[i])) continue;
          const mk = mapKeyOf(lines[i]);
          if (mk && mk.isItem && mk.indent === listIndent && mk.key === 'id') {
            const itemEnd = itemEndAfter(lines, i, blockEnd, listIndent);
            let fIndent = listIndent + 2;
            for (let j = i + 1; j < itemEnd; j += 1) {
              if (isBlank(lines[j]) || isComment(lines[j])) continue;
              fIndent = indentOf(lines[j]);
              break;
            }
            if (modelFieldIndent === null) modelFieldIndent = fIndent;
            const fields = new Map();
            for (let j = i + 1; j < itemEnd; j += 1) {
              const fk = mapKeyOf(lines[j]);
              if (!fk || fk.isItem) continue;
              if (fk.indent !== fIndent) continue;
              if (fields.has(fk.key)) continue;
              fields.set(fk.key, {
                keyLine: j,
                blockEnd: blockEndAfter(lines, j, itemEnd),
                value: fk.value,
                inline: fk.inline,
              });
            }
            provider.models.push({
              id: mk.value,
              itemLine: i,
              blockEnd: itemEnd,
              fieldIndent: fIndent,
              idKeyLine: i,
              fields,
            });
          }
        }
        provider.fieldIndentOfModel = modelFieldIndent;
      }
    }

    provider.compatLine = findKeyLine(lines, keyLine + 1, blockEnd, 'compat');
    result.providers.push(provider);
  }

  return result;
}

/** Locate the `- id: llm-pi-ai` loader entry inside a parsed YAML document. */
function piAiEntryOf(parsed) {
  if (!Array.isArray(parsed)) return null;
  for (const entry of parsed) {
    if (entry && typeof entry === 'object' && entry.id === 'llm-pi-ai') return entry;
  }
  return null;
}

function providerConfigOf(parsed) {
  const entry = piAiEntryOf(parsed);
  if (!entry || !entry.config || typeof entry.config !== 'object') return null;
  const providers = entry.config.providers;
  if (!providers || typeof providers !== 'object') return null;
  return providers;
}

// ------------------------------------------------------------------- rendering

function renderInputBlock(indent, mode) {
  const pad = ' '.repeat(indent);
  const pad2 = ' '.repeat(indent + 2);
  if (mode === 'inherit') return [];
  if (mode === 'text') return [`${pad}input:`, `${pad2}- text`];
  return [`${pad}input:`, `${pad2}- text`, `${pad2}- image`];
}

function renderReasoningBlock(indent, spec) {
  const pad = ' '.repeat(indent);
  const pad2 = ' '.repeat(indent + 2);
  if (!spec || spec.mode === 'inherit') return [];
  if (spec.mode === 'false') return [`${pad}reasoningEfforts: false`];
  const order = new Map(LEVELS.map((level, index) => [level, index]));
  const levels = [...spec.levels].sort((a, b) => order.get(a.level) - order.get(b.level));
  const out = [`${pad}reasoningEfforts:`];
  for (const item of levels) {
    out.push(`${pad2}${item.level}: ${yamlScalar(item.wire === undefined ? null : item.wire)}`);
  }
  return out;
}

/** Normalize a reasoning spec coming from the UI, rejecting what DSH would refuse. */
function normalizeReasoning(spec, label) {
  if (spec === undefined || spec === null) return { mode: 'inherit' };
  const mode = spec.mode;
  if (!REASONING_MODES.includes(mode)) {
    throw new ConfigError(`${label}: 未知的思考模式 "${mode}"`);
  }
  if (mode !== 'levels') return { mode };
  const seen = new Set();
  const levels = [];
  for (const raw of spec.levels || []) {
    const level = String(raw.level);
    if (!LEVELS.includes(level)) throw new ConfigError(`${label}: 未知的思考档位 "${level}"`);
    if (seen.has(level)) continue;
    seen.add(level);
    let wire = raw.wire === undefined ? null : raw.wire;
    if (wire !== null && wire !== undefined) {
      wire = String(wire);
      if (wire.trim().length === 0) {
        throw new ConfigError(`${label}: 档位 "${level}" 的线上取值不能为空`);
      }
    } else {
      wire = null;
    }
    if (level !== 'off' && wire === null) {
      throw new ConfigError(`${label}: 档位 "${level}" 必须填写线上取值（只有 off 可以留空）`);
    }
    levels.push({ level, wire });
  }
  if (levels.length === 0) throw new ConfigError(`${label}: 自定义档位至少要勾选一个档位`);
  if (!levels.some((item) => item.level !== 'off')) {
    throw new ConfigError(`${label}: 除 off 之外至少需要一个档位，否则请改用「显式关闭」`);
  }
  return { mode: 'levels', levels };
}

function normalizeInputMode(mode, label) {
  const value = mode === undefined || mode === null ? 'inherit' : String(mode);
  if (!INPUT_MODES.includes(value)) throw new ConfigError(`${label}: 未知的输入模式 "${mode}"`);
  return value;
}

// ----------------------------------------------------------------- edit engine

function findProvider(scanResult, providerId) {
  return scanResult.providers.find((provider) => provider.id === providerId) || null;
}

function findModel(provider, modelId) {
  return provider.models.find((model) => model.id === modelId) || null;
}

/** Insertion point for a new model field: the end of the model's own lines. */
function modelInsertAt(model) {
  return model.blockEnd;
}

/**
 * Compute the ops for one model's input + reasoning fields.
 *
 * Op ranges never overlap and never tie on the same insertion point: when both
 * fields are missing they are appended as one block, and a new `input` is
 * placed right in front of an existing `reasoningEfforts` block so the file
 * keeps its canonical `name → input → reasoningEfforts` order.
 *
 * @returns {object[]} ops, each `{start, end, lines, note}`
 */
function planModelEdits(model, inputMode, reasoning, label) {
  const inputField = model.fields.get('input');
  const reasonField = model.fields.get('reasoningEfforts');
  const ops = [];
  const wantInputLines = inputMode === 'inherit' ? null : renderInputBlock(model.fieldIndent, inputMode);
  const wantReasonLines = reasoning.mode === 'inherit' ? null : renderReasoningBlock(model.fieldIndent, reasoning);

  // 1) input missing while reasoningEfforts exists: rewrite the reasoning block,
  //    prefixing the new input block so the field order stays canonical.
  if (wantInputLines && !inputField && reasonField) {
    ops.push({
      start: reasonField.keyLine,
      end: reasonField.blockEnd,
      lines: [...wantInputLines, ...(wantReasonLines || [])],
      note: wantReasonLines
        ? `${label}: 新增 input 并更新 reasoningEfforts`
        : `${label}: 新增 input 并移除 reasoningEfforts`,
    });
    return ops;
  }

  // 2) neither field exists: append both as a single block, input first.
  if (!inputField && !reasonField) {
    const lines = [...(wantInputLines || []), ...(wantReasonLines || [])];
    if (lines.length > 0) {
      const added = [wantInputLines ? 'input' : null, wantReasonLines ? 'reasoningEfforts' : null]
        .filter(Boolean)
        .join(' 与 ');
      const at = modelInsertAt(model);
      ops.push({ start: at, end: at, lines, note: `${label}: 新增 ${added}` });
    }
    return ops;
  }

  // 3) general case: each existing field is rewritten in place, otherwise added
  //    at the end of the model's own lines, or removed.
  if (wantInputLines) {
    if (inputField) {
      ops.push({ start: inputField.keyLine, end: inputField.blockEnd, lines: wantInputLines, note: `${label}: 更新 input` });
    } else {
      const at = modelInsertAt(model);
      ops.push({ start: at, end: at, lines: wantInputLines, note: `${label}: 新增 input` });
    }
  } else if (inputMode === 'inherit' && inputField) {
    ops.push({ start: inputField.keyLine, end: inputField.blockEnd, lines: [], note: `${label}: 移除 input` });
  }

  if (wantReasonLines) {
    if (reasonField) {
      ops.push({ start: reasonField.keyLine, end: reasonField.blockEnd, lines: wantReasonLines, note: `${label}: 更新 reasoningEfforts` });
    } else {
      const at = modelInsertAt(model);
      ops.push({ start: at, end: at, lines: wantReasonLines, note: `${label}: 新增 reasoningEfforts` });
    }
  } else if (reasoning.mode === 'inherit' && reasonField) {
    ops.push({ start: reasonField.keyLine, end: reasonField.blockEnd, lines: [], note: `${label}: 移除 reasoningEfforts` });
  }

  return ops;
}

function planCompatEdit(provider, desired, scanResult) {
  const lines = scanResult.lines;
  const compatLine = provider.compatLine;
  const fieldIndent = provider.fieldIndent;

  if (compatLine === -1) {
    if (desired !== true) return null;
    const pad = ' '.repeat(fieldIndent);
    const pad2 = ' '.repeat(fieldIndent + 2);
    const at = provider.modelsLine !== -1 ? provider.modelsLine : provider.blockEnd;
    return {
      start: at,
      end: at,
      lines: [`${pad}compat:`, `${pad2}${EFFORT_SWITCH}: true`],
      note: `${provider.id}: 新增 compat.${EFFORT_SWITCH}`,
    };
  }

  const compatEnd = blockEndAfter(lines, compatLine, provider.blockEnd);
  const switchLine = findKeyLine(lines, compatLine + 1, compatEnd, EFFORT_SWITCH);
  if (desired === true) {
    const pad2 = ' '.repeat(indentOf(lines[compatLine]) + 2);
    const valueLine = `${pad2}${EFFORT_SWITCH}: true`;
    if (switchLine === -1) {
      return { start: compatLine + 1, end: compatLine + 1, lines: [valueLine], note: `${provider.id}: 新增 compat.${EFFORT_SWITCH}` };
    }
    const mk = mapKeyOf(lines[switchLine]);
    if (mk.value === 'true') return null;
    return { start: switchLine, end: blockEndAfter(lines, switchLine, compatEnd), lines: [valueLine], note: `${provider.id}: 修正 compat.${EFFORT_SWITCH}` };
  }

  if (desired === false && switchLine !== -1) {
    const otherKeys = [];
    for (let i = compatLine + 1; i < compatEnd; i += 1) {
      const mk = mapKeyOf(lines[i]);
      if (mk && !mk.isItem && indentOf(lines[i]) === indentOf(lines[compatLine]) + 2 && mk.key !== EFFORT_SWITCH) {
        otherKeys.push(mk.key);
      }
    }
    if (otherKeys.length === 0) {
      return { start: compatLine, end: compatEnd, lines: [], note: `${provider.id}: 移除空的 compat 块` };
    }
    return {
      start: switchLine,
      end: blockEndAfter(lines, switchLine, compatEnd),
      lines: [],
      note: `${provider.id}: 移除不适用于该协议的 compat.${EFFORT_SWITCH}`,
    };
  }

  return null;
}

function applyOps(lines, ops) {
  const ordered = [...ops].sort((a, b) => b.start - a.start || b.end - a.end || b.seq - a.seq);
  const out = [...lines];
  for (const op of ordered) {
    out.splice(op.start, op.end - op.start, ...op.lines);
  }
  return out;
}

/** Independently compute what the parsed config must look like after the edits. */
function expectedAfter(parsed, changes, compatChanges) {
  const expected = deepClone(parsed);
  const providers = providerConfigOf(expected);
  if (!providers) throw new ConfigError('解析结果中缺少 llm-pi-ai.config.providers');

  for (const change of changes) {
    const provider = providers[change.provider];
    if (!provider || !Array.isArray(provider.models)) {
      throw new ConfigError(`解析结果中找不到 provider "${change.provider}"`);
    }
    const model = provider.models.find((item) => item && item.id === change.model);
    if (!model) throw new ConfigError(`解析结果中找不到模型 "${change.model}"`);

    if (change.input === 'inherit') delete model.input;
    else if (change.input === 'text') model.input = ['text'];
    else model.input = ['text', 'image'];

    if (change.reasoning.mode === 'inherit') delete model.reasoningEfforts;
    else if (change.reasoning.mode === 'false') model.reasoningEfforts = false;
    else {
      const order = new Map(LEVELS.map((level, index) => [level, index]));
      const levels = [...change.reasoning.levels].sort((a, b) => order.get(a.level) - order.get(b.level));
      const value = {};
      for (const item of levels) value[item.level] = item.wire === null ? null : item.wire;
      model.reasoningEfforts = value;
    }
  }

  for (const change of compatChanges) {
    const provider = providers[change.provider];
    if (!provider) continue;
    const compat = provider.compat && typeof provider.compat === 'object' ? provider.compat : null;
    if (change.desired === true) {
      provider.compat = { ...(compat || {}), [EFFORT_SWITCH]: true };
    } else if (change.desired === false) {
      if (!compat) continue;
      delete compat[EFFORT_SWITCH];
      if (Object.keys(compat).length === 0) delete provider.compat;
      else provider.compat = compat;
    }
  }

  return expected;
}

/** Does this provider end up with a model that declares thinking levels? */
function providerDeclaresLevels(providerConfig, scanProvider, editsByModel) {
  const models =
    providerConfig && Array.isArray(providerConfig.models) ? providerConfig.models : [];
  for (const model of models) {
    if (!model || typeof model !== 'object') continue;
    const edited = editsByModel.get(model.id);
    if (edited) {
      if (edited.reasoning.mode === 'levels') return true;
      continue;
    }
    const current = model.reasoningEfforts;
    if (current && typeof current === 'object' && Object.keys(current).length > 0) return true;
  }
  return false;
}

/**
 * Build an edited document from declarative requests.
 * @param {string} text - current file text.
 * @param {unknown} parsed - js-yaml parse of the same text.
 * @param {{edits: object[], autoCompat?: boolean}} request
 * @returns {{text: string, notes: string[], changes: object[], compatChanges: object[], expected: unknown, warnings: string[]}}
 */
function buildEdit(text, parsed, request) {
  const scanResult = scan(text);
  if (scanResult.errors.length > 0) throw new ConfigError(scanResult.errors.join('；'));
  const providers = providerConfigOf(parsed);
  if (!providers) throw new ConfigError('解析结果中缺少 llm-pi-ai.config.providers');

  const edits = Array.isArray(request.edits) ? request.edits : [];
  if (edits.length === 0) throw new ConfigError('没有需要修改的模型');

  const warnings = [];
  const notes = [];
  const changes = [];
  const ops = [];
  const editsByModel = new Map();
  const touchedProviders = new Set();

  for (const edit of edits) {
    const providerId = String(edit.provider);
    const modelId = String(edit.model);
    const label = `${providerId}/${modelId}`;
    const scanProvider = findProvider(scanResult, providerId);
    if (!scanProvider) throw new ConfigError(`配置文件中找不到 provider "${providerId}"`);
    const scanModel = findModel(scanProvider, modelId);
    if (!scanModel) throw new ConfigError(`provider "${providerId}" 下找不到模型 "${modelId}"`);

    const inputMode = normalizeInputMode(edit.input, label);
    const reasoning = normalizeReasoning(edit.reasoning, label);
    const planned = planModelEdits(scanModel, inputMode, reasoning, label);
    for (const op of planned) {
      op.seq = ops.length;
      ops.push(op);
      notes.push(op.note);
    }

    touchedProviders.add(providerId);
    editsByModel.set(modelId, { input: inputMode, reasoning });
    changes.push({ provider: providerId, model: modelId, input: inputMode, reasoning });
  }

  // Provider-level protocol switch, applied automatically and reported as a change.
  const compatChanges = [];
  if (request.autoCompat !== false) {
    for (const providerId of touchedProviders) {
      const scanProvider = findProvider(scanResult, providerId);
      const providerConfig = providers[providerId];
      const api = providerConfig && providerConfig.api;
      const localEdits = new Map();
      for (const [modelId, edit] of editsByModel) {
        if (changes.some((c) => c.provider === providerId && c.model === modelId)) localEdits.set(modelId, edit);
      }
      const declaresLevels = providerDeclaresLevels(providerConfig, scanProvider, localEdits);
      let desired = null;
      if (api === EFFORT_PROTOCOL) {
        if (declaresLevels) desired = true;
      } else if (scanProvider.compatLine !== -1) {
        desired = false;
        warnings.push(
          `provider "${providerId}" 的协议是 ${api}，不提供 ${EFFORT_SWITCH}；已按协议移除该开关（Responses API 使用自身的 reasoning 字段）`,
        );
      }
      if (desired === null) continue;
      const op = planCompatEdit(scanProvider, desired, scanResult);
      compatChanges.push({ provider: providerId, desired });
      if (op) {
        ops.push(op);
        notes.push(op.note);
      }
    }
  }

  const nextLines = applyOps(scanResult.lines, ops);
  const nextText = nextLines.join(scanResult.eol);
  const expected = expectedAfter(parsed, changes, compatChanges);

  return { text: nextText, notes, ops, changes, compatChanges, expected, warnings };
}

module.exports = {
  LEVELS,
  INPUT_MODES,
  REASONING_MODES,
  EFFORT_PROTOCOL,
  EFFORT_SWITCH,
  ConfigError,
  scan,
  piAiEntryOf,
  providerConfigOf,
  buildEdit,
  splitLines,
  detectEol,
};
