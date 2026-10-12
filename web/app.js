'use strict';

const state = {
  providers: [],
  levels: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  fingerprint: null,
  path: '',
  currentProvider: null,
  draft: new Map(),
  suggestions: new Map(),
};

const LEVEL_DEFAULT_WIRE = {
  off: null,
  minimal: 'minimal',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: 'max',
};

const STANDARD_LEVELS = [
  { level: 'off', wire: null },
  { level: 'low', wire: 'low' },
  { level: 'medium', wire: 'medium' },
  { level: 'high', wire: 'high' },
];

const VISION_YES = [/qwen/i, /gemini/i, /grok/i, /claude/i, /gpt[-_]?[456]/i, /vision/i, /(^|[^a-z])vl([^a-z]|$)/i, /mimo/i, /pixtral/i, /internvl/i, /llava/i, /minicpm/i, /doubao/i];
const VISION_NO = [/embed/i, /rerank/i, /tts/i, /whisper/i, /audio/i, /voxtral/i, /transcri/i, /(^|[^a-z])stt([^a-z]|$)/i, /(^|[^a-z])ocr([^a-z]|$)/i, /moderation/i, /guard/i, /flux/i, /dall/i];
const NO_REASONING = [/embed/i, /rerank/i, /tts/i, /whisper/i, /audio/i, /voxtral/i, /transcri/i, /(^|[^a-z])stt([^a-z]|$)/i, /(^|[^a-z])ocr([^a-z]|$)/i, /moderation/i];

const el = (id) => document.getElementById(id);
const keyOf = (provider, model) => `${provider}::${model}`;

// ------------------------------------------------------------------ API helpers

async function api(path, body) {
  const response = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({ ok: false, error: '服务返回了非 JSON 内容' }));
  return { status: response.status, payload };
}

function setStatus(text, kind = '') {
  const node = el('status');
  node.textContent = text;
  node.className = `status ${kind}`;
}

function showBanner(text) {
  const node = el('banner');
  if (!text) {
    node.classList.add('hidden');
    node.textContent = '';
    return;
  }
  node.classList.remove('hidden');
  node.textContent = text;
}

// -------------------------------------------------------------- draft handling

function baseModel(providerId, modelId) {
  const provider = state.providers.find((item) => item.id === providerId);
  if (!provider) return null;
  return provider.models.find((item) => item.id === modelId) || null;
}

function baseEntry(providerId, modelId) {
  const model = baseModel(providerId, modelId);
  if (!model) return null;
  return {
    input: model.input,
    reasoning: { mode: model.reasoning.mode, levels: model.reasoning.levels.map((item) => ({ ...item })) },
  };
}

function getDraft(providerId, modelId) {
  const key = keyOf(providerId, modelId);
  if (!state.draft.has(key)) state.draft.set(key, baseEntry(providerId, modelId));
  return state.draft.get(key);
}

function setDraft(providerId, modelId, patch) {
  const current = getDraft(providerId, modelId);
  state.draft.set(keyOf(providerId, modelId), { ...current, ...patch });
}

function normalizeLevels(levels) {
  const order = new Map(state.levels.map((level, index) => [level, index]));
  return [...levels].sort((a, b) => order.get(a.level) - order.get(b.level));
}

function isDirty(providerId, modelId) {
  const base = baseEntry(providerId, modelId);
  const draft = getDraft(providerId, modelId);
  if (!base || !draft) return false;
  if (base.input !== draft.input) return true;
  if (base.reasoning.mode !== draft.reasoning.mode) return true;
  if (draft.reasoning.mode !== 'levels') return false;
  const a = normalizeLevels(base.reasoning.levels);
  const b = normalizeLevels(draft.reasoning.levels);
  if (a.length !== b.length) return true;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i].level !== b[i].level || a[i].wire !== b[i].wire) return true;
  }
  return false;
}

function dirtyKeys() {
  const out = [];
  for (const provider of state.providers) {
    for (const model of provider.models) {
      if (!model.editable) continue;
      if (isDirty(provider.id, model.id)) out.push(keyOf(provider.id, model.id));
    }
  }
  return out;
}

function collectEdits() {
  const edits = [];
  for (const provider of state.providers) {
    for (const model of provider.models) {
      if (!model.editable || !isDirty(provider.id, model.id)) continue;
      const draft = getDraft(provider.id, model.id);
      edits.push({
        provider: provider.id,
        model: model.id,
        input: draft.input,
        reasoning:
          draft.reasoning.mode === 'levels'
            ? { mode: 'levels', levels: normalizeLevels(draft.reasoning.levels) }
            : { mode: draft.reasoning.mode },
      });
    }
  }
  return edits;
}

// ------------------------------------------------------------------ suggestions

function suggestFor(model) {
  const id = model.id;
  const noReasoning = NO_REASONING.some((re) => re.test(id));
  const visionNo = VISION_NO.some((re) => re.test(id));
  const visionYes = !visionNo && VISION_YES.some((re) => re.test(id));
  return {
    input: visionYes ? 'text+image' : visionNo ? 'text' : null,
    reasoning: noReasoning ? { mode: 'false' } : { mode: 'levels', levels: STANDARD_LEVELS.map((l) => ({ ...l })) },
    reason: visionYes
      ? '模型名提示可能具备视觉能力（需自行确认后保存）'
      : visionNo
        ? '模型名提示为非视觉模型（音频/检索/生成类）'
        : '无法从名称判断视觉能力，保持原样',
  };
}

// --------------------------------------------------------------------- renders

function renderProviderList() {
  const list = el('providerList');
  list.innerHTML = '';
  el('providerCount').textContent = String(state.providers.length);
  for (const provider of state.providers) {
    const providerDirty = provider.models.some((model) => model.editable && isDirty(provider.id, model.id));
    const li = document.createElement('li');
    li.className = `${provider.id === state.currentProvider ? 'active' : ''} ${providerDirty ? 'dirty' : ''}`;
    li.innerHTML = `<span>${escapeHtml(provider.displayName || provider.id)}</span><span class="cnt">${provider.models.length}</span>`;
    li.title = provider.id;
    li.addEventListener('click', () => {
      state.currentProvider = provider.id;
      renderProviderList();
      renderPanel();
    });
    list.appendChild(li);
  }
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}

function inputSelectHtml(providerId, modelId, current) {
  const options = [
    ['inherit', '继承默认（纯文本）'],
    ['text', '仅文本'],
    ['text+image', '文本 + 图片'],
  ];
  return `<select data-role="input" data-provider="${escapeHtml(providerId)}" data-model="${escapeHtml(modelId)}">${options
    .map(([value, label]) => `<option value="${value}" ${value === current ? 'selected' : ''}>${label}</option>`)
    .join('')}</select>`;
}

function reasoningSelectHtml(providerId, modelId, current) {
  const options = [
    ['inherit', '继承默认（不声明）'],
    ['levels', '自定义档位'],
    ['false', '显式关闭'],
  ];
  return `<select data-role="reasoning" data-provider="${escapeHtml(providerId)}" data-model="${escapeHtml(modelId)}">${options
    .map(([value, label]) => `<option value="${value}" ${value === current ? 'selected' : ''}>${label}</option>`)
    .join('')}</select>`;
}

function levelsHtml(providerId, modelId, draft) {
  if (draft.reasoning.mode !== 'levels') {
    const hint =
      draft.reasoning.mode === 'false'
        ? '该模型不发送任何思考档位（reasoningEfforts: false）'
        : '不声明 ⇢ 使用 DSH 默认行为';
    return `<span class="note">${hint}</span>`;
  }
  const selected = new Map(draft.reasoning.levels.map((item) => [item.level, item.wire]));
  return `<div class="levels">${state.levels
    .map((level) => {
      const checked = selected.has(level);
      const wire = checked ? selected.get(level) : LEVEL_DEFAULT_WIRE[level];
      const wireValue = checked ? (wire === null || wire === undefined ? '' : String(wire)) : '';
      return `<span class="level">
        <input type="checkbox" data-role="level" data-level="${level}" data-provider="${escapeHtml(providerId)}" data-model="${escapeHtml(modelId)}" ${checked ? 'checked' : ''} />
        <span>${level}</span>
        <input type="text" data-role="wire" data-level="${level}" data-provider="${escapeHtml(providerId)}" data-model="${escapeHtml(modelId)}"
          value="${escapeHtml(wireValue)}" placeholder="${level === 'off' ? '空=null' : '线上取值'}" ${checked ? '' : 'disabled'} />
      </span>`;
    })
    .join('')}</div>`;
}

function renderPanel() {
  const provider = state.providers.find((item) => item.id === state.currentProvider);
  const head = el('providerHead');
  const table = el('modelTable');
  if (!provider) {
    head.innerHTML = '';
    table.innerHTML = '<p class="note">请选择左侧 Provider</p>';
    return;
  }

  const switchTag = provider.supportsEffortProtocol
    ? provider.effortSwitch
      ? '<span class="tag good">compat.supportsReasoningEffort: true</span>'
      : '<span class="tag warn">缺少 compat.supportsReasoningEffort（保存思考档位时会自动补上）</span>'
    : `<span class="tag">${escapeHtml(provider.api || '未知协议')} · 该协议不用 supportsReasoningEffort</span>`;

  head.innerHTML = `<h2>${escapeHtml(provider.displayName || provider.id)} <span class="tag">${escapeHtml(provider.id)}</span> ${switchTag}</h2>
    <div class="provider-meta">${escapeHtml(provider.baseURL || '（无 baseURL）')} · ${provider.models.length} 个模型</div>`;

  const rows = provider.models
    .map((model) => {
      const draft = getDraft(provider.id, model.id);
      const dirty = isDirty(provider.id, model.id);
      const suggestion = state.suggestions.get(keyOf(provider.id, model.id));
      const sub = [];
      if (model.name && model.name !== model.id) sub.push(model.name);
      if (model.contextWindow) sub.push(`ctx ${model.contextWindow}`);
      if (!model.inputKnown) sub.push(`input 值无法识别：${JSON.stringify(model.inputRaw)}`);
      const suggestionHint = suggestion
        ? `<div class="note">建议：图片→${suggestion.input === 'text+image' ? '开启' : suggestion.input === 'text' ? '关闭' : '保持不变'} · 思考→${
            suggestion.reasoning.mode === 'false' ? '显式关闭' : '标准四档'
          }（${escapeHtml(suggestion.reason)}）</div>`
        : '';
      return `<tr class="${dirty ? 'dirty' : ''}">
        <td><div class="model-id">${escapeHtml(model.id)}</div>${sub.length ? `<div class="model-sub">${escapeHtml(sub.join(' · '))}</div>` : ''}${
          model.editable ? '' : '<div class="warn-text">该模型没有可编辑的 YAML 节点（可能来自 modelOverrides）</div>'
        }${suggestionHint}</td>
        <td>${model.editable ? inputSelectHtml(provider.id, model.id, draft.input) : ''}</td>
        <td>${model.editable ? reasoningSelectHtml(provider.id, model.id, draft.reasoning.mode) : ''}</td>
        <td>${model.editable ? levelsHtml(provider.id, model.id, draft) : ''}</td>
        <td>${dirty ? `<button class="mini ghost" data-role="rowreset" data-provider="${escapeHtml(provider.id)}" data-model="${escapeHtml(model.id)}">撤销</button>` : ''}</td>
      </tr>`;
    })
    .join('');

  table.innerHTML = `<table>
    <thead><tr><th style="width:32%">模型</th><th style="width:22%">图片输入</th><th style="width:16%">思考</th><th>档位（线上取值）</th><th></th></tr></thead>
    <tbody>${rows}</tbody></table>`;
}

function renderDirtyInfo() {
  const keys = dirtyKeys();
  const node = el('dirtyInfo');
  node.textContent = keys.length === 0 ? '没有未保存的改动' : `有 ${keys.length} 个模型待保存`;
  node.className = `dirty ${keys.length ? 'active' : ''}`;
  el('btnSave').disabled = keys.length === 0;
  el('btnPreview').disabled = keys.length === 0;
}

function renderAll() {
  renderProviderList();
  renderPanel();
  renderDirtyInfo();
}

// ------------------------------------------------------------------ interactions

document.addEventListener('change', (event) => {
  const target = event.target;
  const role = target.dataset ? target.dataset.role : null;
  if (!role) return;
  const providerId = target.dataset.provider;
  const modelId = target.dataset.model;

  if (role === 'input') {
    setDraft(providerId, modelId, { input: target.value });
  } else if (role === 'reasoning') {
    const draft = getDraft(providerId, modelId);
    if (target.value === 'levels') {
      const levels = draft.reasoning.levels.length ? draft.reasoning.levels : STANDARD_LEVELS.map((l) => ({ ...l }));
      setDraft(providerId, modelId, { reasoning: { mode: 'levels', levels } });
    } else {
      setDraft(providerId, modelId, { reasoning: { mode: target.value, levels: [] } });
    }
  } else if (role === 'level') {
    const draft = getDraft(providerId, modelId);
    const level = target.dataset.level;
    const levels = draft.reasoning.levels.filter((item) => item.level !== level);
    if (target.checked) levels.push({ level, wire: LEVEL_DEFAULT_WIRE[level] });
    setDraft(providerId, modelId, { reasoning: { mode: 'levels', levels } });
  } else if (role === 'wire') {
    const draft = getDraft(providerId, modelId);
    const level = target.dataset.level;
    const levels = draft.reasoning.levels.map((item) =>
      item.level === level ? { level, wire: target.value.trim() === '' ? null : target.value.trim() } : item,
    );
    setDraft(providerId, modelId, { reasoning: { mode: 'levels', levels } });
  }
  renderAll();
});

document.addEventListener('click', (event) => {
  const target = event.target;
  if (target.dataset && target.dataset.role === 'rowreset') {
    state.draft.delete(keyOf(target.dataset.provider, target.dataset.model));
    renderAll();
    return;
  }
  if (target.dataset && target.dataset.close) {
    el(target.dataset.close).close();
    return;
  }
  const bulk = target.dataset ? target.dataset.bulk : null;
  if (bulk) applyBulk(bulk);
});

function applyBulk(action) {
  const provider = state.providers.find((item) => item.id === state.currentProvider);
  if (!provider) return;
  const editable = provider.models.filter((model) => model.editable);

  if (action === 'clear') {
    for (const model of editable) state.draft.delete(keyOf(provider.id, model.id));
    state.suggestions.clear();
    renderAll();
    return;
  }

  if (action === 'suggest') {
    for (const model of editable) {
      const suggestion = suggestFor(model);
      state.suggestions.set(keyOf(provider.id, model.id), suggestion);
      const patch = {};
      if (suggestion.input) patch.input = suggestion.input;
      patch.reasoning = suggestion.reasoning;
      setDraft(provider.id, model.id, patch);
    }
    renderAll();
    setStatus('已按模型名填入建议值，请逐条确认后再保存（名称只是启发式判断）', '');
    return;
  }

  for (const model of editable) {
    if (action === 'input:on') setDraft(provider.id, model.id, { input: 'text+image' });
    else if (action === 'input:off') setDraft(provider.id, model.id, { input: 'text' });
    else if (action === 'reason:standard') {
      setDraft(provider.id, model.id, { reasoning: { mode: 'levels', levels: STANDARD_LEVELS.map((l) => ({ ...l })) } });
    } else if (action === 'reason:false') setDraft(provider.id, model.id, { reasoning: { mode: 'false', levels: [] } });
  }
  renderAll();
}

// ------------------------------------------------------------------ diff / save

async function requestPreview() {
  return api('/api/preview', { edits: collectEdits(), fingerprint: state.fingerprint, autoCompat: true });
}

function renderDiff(target, diff) {
  if (!diff) {
    target.textContent = '没有差异';
    return;
  }
  target.innerHTML = diff
    .split('\n')
    .map((line) => {
      const cls = line.startsWith('+++') || line.startsWith('---') ? 'ctx' : line.startsWith('@@') ? 'hunk' : line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : 'ctx';
      return `<span class="${cls}">${escapeHtml(line)}</span>`;
    })
    .join('\n');
}

async function openPreview() {
  const edits = collectEdits();
  if (edits.length === 0) return;
  const { status, payload } = await requestPreview();
  if (!payload.ok) {
    setStatus(payload.error || '预览失败', 'err');
    if (status === 409) await loadState();
    return;
  }
  el('diffSummary').textContent = [
    `将修改 ${edits.length} 个模型（+${payload.added} / -${payload.removed} 行）`,
    payload.notes.join('\n'),
    payload.warnings.length ? `\n注意：\n${payload.warnings.join('\n')}` : '',
  ]
    .filter(Boolean)
    .join('\n');
  renderDiff(el('diffBody'), payload.diff);
  el('diffHint').textContent =
    payload.warnings.length > 0
      ? '存在协议层面的注意事项，确认无误后再写入。写入前会自动备份当前文件。'
      : '确认无误后点击「写入配置」，写入前会自动备份当前文件。';
  el('diffDialog').showModal();
}

async function openSave() {
  const edits = collectEdits();
  if (edits.length === 0) return;
  const { status, payload } = await api('/api/save', { edits, fingerprint: state.fingerprint, autoCompat: true });
  if (!payload.ok) {
    setStatus(payload.error || '保存失败', 'err');
    showBanner([payload.error, ...(payload.details || [])].join('\n'));
    if (status === 409) await loadState();
    return;
  }
  el('diffDialog').close();
  showBanner('');
  setStatus(`已写入 ${edits.length} 个模型的改动，备份：${payload.backup}`, 'ok');
  state.draft.clear();
  state.suggestions.clear();
  await loadState();
  el('diffSummary').textContent = [
    `已写入 ${edits.length} 个模型（+${payload.added} / -${payload.removed} 行）`,
    `备份文件：${payload.backup}`,
    '重启 DSH Desktop（或重新加载 profile）后生效。',
  ].join('\n');
  renderDiff(el('diffBody'), payload.diff);
  el('diffHint').textContent = '已完成写入。此对话框仅作记录，可关闭。';
  el('diffDialog').showModal();
}

// --------------------------------------------------------------------- backups

async function openBackups() {
  const { payload } = await api('/api/backups');
  const list = el('backupList');
  if (!payload.ok || payload.backups.length === 0) {
    list.innerHTML = '<p class="note">还没有备份。第一次保存时会自动创建。</p>';
  } else {
    list.innerHTML = `<table><thead><tr><th>备份文件</th><th>时间</th><th>大小</th><th></th></tr></thead><tbody>${payload.backups
      .map(
        (item) => `<tr><td class="mono">${escapeHtml(item.name)}</td><td>${escapeHtml(new Date(item.mtime).toLocaleString())}</td><td>${item.size} B</td><td><button class="mini" data-role="restore" data-backup="${escapeHtml(item.name)}">恢复</button></td></tr>`,
      )
      .join('')}</tbody></table>`;
  }
  el('backupDir').textContent = payload.backupDir ? `备份目录：${payload.backupDir}` : '';
  el('backupDialog').showModal();
}

document.addEventListener('click', async (event) => {
  if (event.target.dataset && event.target.dataset.role === 'restore') {
    const name = event.target.dataset.backup;
    if (!window.confirm(`恢复配置为备份 ${name}？\n当前文件会先被自动备份一份。`)) return;
    const { payload } = await api('/api/restore', { backup: name });
    if (!payload.ok) {
      setStatus(payload.error || '恢复失败', 'err');
      return;
    }
    el('backupDialog').close();
    state.draft.clear();
    await loadState();
    setStatus(`已从 ${name} 恢复，安全备份：${payload.safetyBackup}`, 'ok');
  }
});

// ------------------------------------------------------------------ bootstrap

async function loadState() {
  const { payload } = await api('/api/state');
  if (!payload.ok) {
    setStatus(payload.error || '读取配置失败', 'err');
    return;
  }
  state.providers = payload.providers;
  state.levels = payload.levels;
  state.fingerprint = payload.fingerprint;
  state.path = payload.path;
  if (!state.currentProvider || !state.providers.some((item) => item.id === state.currentProvider)) {
    state.currentProvider = state.providers.length ? state.providers[0].id : null;
  }
  el('configPath').textContent = payload.path;
  el('configPath').title = payload.path;

  const notices = [];
  if (payload.parseError) notices.push(payload.parseError);
  if (payload.scanErrors && payload.scanErrors.length) notices.push(...payload.scanErrors);
  if (!payload.entryFound) notices.push('配置文件中没有找到 `- id: llm-pi-ai` 条目，无法定位模型配置');
  showBanner(notices.join('\n'));

  const total = state.providers.reduce((sum, provider) => sum + provider.models.length, 0);
  setStatus(`已读取 ${state.providers.length} 个 provider / ${total} 个模型 · ${new Date(payload.mtime).toLocaleString()}`, 'ok');
  renderAll();
}

el('btnReload').addEventListener('click', loadState);
el('btnResetAll').addEventListener('click', () => {
  state.draft.clear();
  state.suggestions.clear();
  renderAll();
});
el('btnPreview').addEventListener('click', openPreview);
el('btnSave').addEventListener('click', openPreview);
el('btnConfirmSave').addEventListener('click', openSave);
el('btnBackups').addEventListener('click', openBackups);
el('btnShutdown').addEventListener('click', async () => {
  const dirty = dirtyKeys().length;
  const message =
    dirty > 0
      ? `还有 ${dirty} 个模型未保存，关闭后这些改动会丢失。\n（已保存到配置文件的内容不受影响）\n\n确定关闭本地服务？`
      : '确定关闭本地服务？\n（已保存的配置不受影响，仅停止这个本地网页服务）';
  if (!window.confirm(message)) return;
  const { payload } = await api('/api/shutdown', {});
  document.body.classList.add('shutdown');
  document.querySelectorAll('button').forEach((node) => {
    node.disabled = true;
  });
  showBanner('');
  setStatus(payload.ok ? '服务已关闭，可以直接关闭此页面。重新使用请再运行 start.cmd。' : '关闭请求失败，可手动结束进程。', payload.ok ? 'ok' : 'err');
  el('dirtyInfo').textContent = '服务已关闭';
  el('dirtyInfo').className = 'dirty';
});
el('btnSwitch').addEventListener('click', async () => {
  const next = window.prompt('输入要编辑的配置文件完整路径：', state.path);
  if (!next) return;
  const { payload } = await api('/api/config', { path: next });
  if (!payload.ok) {
    setStatus(payload.error || '切换失败', 'err');
    return;
  }
  state.draft.clear();
  state.suggestions.clear();
  await loadState();
});

loadState();
