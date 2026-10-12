'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const yaml = require('../vendor/js-yaml.js');
const editor = require('../src/editor');
const { verifyPreimage } = require('../src/verify');
const { unifiedDiff } = require('../src/diff');
const { deepEqual } = require('../src/util');

const FIXTURE = `# 顶部注释必须保留
- id: ui-chat
  name: "@deepseek-ai/dsh-client-ui-chat"
  config:
    transcriptView: standard
# 中间注释也要保留
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      alpha:
        displayName: Alpha
        apiKeyEnv: ALPHA_API_KEY
        api: openai-completions
        baseURL: https://alpha.example/v1
        compat:
          supportsReasoningEffort: true
        models:
          - id: alpha-vision
            name: alpha-vision
            input:
              - text
              - image
            reasoningEfforts:
              off: null
              low: low
          - id: alpha-text
            name: alpha-text
      beta:
        displayName: Beta
        apiKeyEnv: BETA_API_KEY
        api: openai-responses
        baseURL: https://beta.example/v1
        compat:
          supportsReasoningEffort: true
          otherFlag: 1
        models:
          - id: "[beta]model"
            name: "[beta]model"
- id: web-search-deepseek
  name: "@deepseek-ai/dsh-web-search-deepseek"
  config:
    apiKeyEnv: DEEPSEEK_API_KEY
`;

/** Build + verify exactly like the server does, so tests exercise the real path. */
function build(text, request) {
  const parsed = yaml.load(text);
  const built = editor.buildEdit(text, parsed, request);
  const preimageErrors = verifyPreimage(editor.splitLines(text), editor.splitLines(built.text), built.ops);
  assert.deepEqual(preimageErrors, [], `预镜像校验失败：\n${preimageErrors.join('\n')}`);
  const reparsed = yaml.load(built.text);
  assert.ok(deepEqual(reparsed, built.expected), '语义校验不一致');
  return { built, parsed, reparsed };
}

test('scan 能定位 provider 与模型的编辑行', () => {
  const result = editor.scan(FIXTURE);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(
    result.providers.map((provider) => provider.id),
    ['alpha', 'beta'],
  );
  const alpha = result.providers[0];
  assert.deepEqual(
    alpha.models.map((model) => model.id),
    ['alpha-vision', 'alpha-text'],
  );
  assert.equal(alpha.models[0].itemLine + 1, FIXTURE.split('\n').findIndex((l) => l.includes('alpha-vision')) + 1);
  assert.ok(alpha.models[1].fields.has('name'));
  assert.ok(!alpha.models[1].fields.has('input'));
  assert.ok(alpha.models[0].fields.get('input').blockEnd > alpha.models[0].fields.get('input').keyLine);
});

test('为缺少 input 的模型新增图片输入，且不影响其他行', () => {
  const { built, reparsed } = build(FIXTURE, {
    edits: [{ provider: 'alpha', model: 'alpha-text', input: 'text+image', reasoning: { mode: 'inherit' } }],
  });
  const providers = editor.providerConfigOf(reparsed);
  assert.deepEqual(providers.alpha.models.find((m) => m.id === 'alpha-text').input, ['text', 'image']);
  assert.match(built.text, /- id: alpha-text\n {12}name: alpha-text\n {12}input:\n {14}- text\n {14}- image\n/);
  assert.ok(built.text.includes('          otherFlag: 1'), '其他 provider 内容应原样保留');
  assert.ok(built.text.includes('# 顶部注释必须保留'), '注释应保留');
});

test('为已有档位但缺 input 的模型补图片时，字段顺序保持 input 在 reasoningEfforts 之前', () => {
  const { built, reparsed } = build(FIXTURE, {
    edits: [
      {
        provider: 'alpha',
        model: 'alpha-text',
        input: 'text+image',
        reasoning: { mode: 'levels', levels: [{ level: 'off', wire: null }, { level: 'low', wire: 'low' }] },
      },
      {
        provider: 'alpha',
        model: 'alpha-vision',
        input: 'text+image',
        reasoning: { mode: 'levels', levels: [{ level: 'off', wire: null }, { level: 'low', wire: 'low' }, { level: 'high', wire: 'high' }] },
      },
    ],
  });
  assert.match(
    built.text,
    /- id: alpha-vision\n {12}name: alpha-vision\n {12}input:\n {14}- text\n {14}- image\n {12}reasoningEfforts:\n {14}off: null\n {14}low: low\n {14}high: high/,
  );
  const model = editor.providerConfigOf(reparsed).alpha.models.find((m) => m.id === 'alpha-vision');
  assert.deepEqual(Object.keys(model), ['id', 'name', 'input', 'reasoningEfforts']);
});

test('两个字段都不存在的模型会一次性追加，图片在思考之前', () => {
  const { built } = build(FIXTURE, {
    edits: [
      {
        provider: 'alpha',
        model: 'alpha-text',
        input: 'text+image',
        reasoning: { mode: 'levels', levels: [{ level: 'off', wire: null }, { level: 'minimal', wire: 'minimal' }, { level: 'low', wire: 'low' }, { level: 'medium', wire: 'medium' }, { level: 'high', wire: 'high' }] },
      },
    ],
  });
  assert.match(
    built.text,
    /- id: alpha-text\n {12}name: alpha-text\n {12}input:\n {14}- text\n {14}- image\n {12}reasoningEfforts:/,
  );
  assert.equal((built.text.match(/reasoningEfforts:/g) || []).length, 2);
});

test('把模型改回纯文本会移除 input 块', () => {
  const { reparsed, built } = build(FIXTURE, {
    edits: [
      {
        provider: 'alpha',
        model: 'alpha-vision',
        input: 'inherit',
        reasoning: { mode: 'levels', levels: [{ level: 'off', wire: null }, { level: 'low', wire: 'low' }] },
      },
    ],
  });
  const model = editor.providerConfigOf(reparsed).alpha.models.find((m) => m.id === 'alpha-vision');
  assert.equal(model.input, undefined);
  assert.deepEqual(model.reasoningEfforts, { off: null, low: 'low' }, 'reasoningEfforts 不应被误删');
  assert.ok(!/\n {12}input:/.test(built.text), 'input 块应被整体移除');
  assert.ok(built.text.includes('- id: alpha-text'), '后续模型应完整保留');
});

test('思考档位按 canonical 顺序写入，off 渲染为 null', () => {
  const { built, reparsed } = build(FIXTURE, {
    edits: [
      {
        provider: 'alpha',
        model: 'alpha-text',
        input: 'inherit',
        reasoning: {
          mode: 'levels',
          levels: [
            { level: 'high', wire: 'high' },
            { level: 'off', wire: null },
            { level: 'medium', wire: 'medium' },
            { level: 'minimal', wire: 'minimal' },
          ],
        },
      },
    ],
  });
  assert.match(
    built.text,
    /reasoningEfforts:\n {14}off: null\n {14}minimal: minimal\n {14}medium: medium\n {14}high: high/,
  );
  const model = editor.providerConfigOf(reparsed).alpha.models.find((m) => m.id === 'alpha-text');
  assert.deepEqual(model.reasoningEfforts, { off: null, minimal: 'minimal', medium: 'medium', high: 'high' });
});

test('reasoningEfforts: false 可显式关闭', () => {
  const { built, reparsed } = build(FIXTURE, {
    edits: [{ provider: 'alpha', model: 'alpha-text', input: 'inherit', reasoning: { mode: 'false' } }],
  });
  assert.match(built.text, /- id: alpha-text\n {12}name: alpha-text\n {12}reasoningEfforts: false/);
  assert.equal(editor.providerConfigOf(reparsed).alpha.models.find((m) => m.id === 'alpha-text').reasoningEfforts, false);
});

test('openai-completions 会自动补上 compat.supportsReasoningEffort', () => {
  const text = FIXTURE.replace('        compat:\n          supportsReasoningEffort: true\n        models:\n          - id: alpha-vision', '        models:\n          - id: alpha-vision');
  const { built, reparsed } = build(text, {
    edits: [
      {
        provider: 'alpha',
        model: 'alpha-text',
        input: 'inherit',
        reasoning: { mode: 'levels', levels: [{ level: 'low', wire: 'low' }, { level: 'off', wire: null }] },
      },
    ],
  });
  assert.equal(editor.providerConfigOf(reparsed).alpha.compat.supportsReasoningEffort, true);
  assert.match(built.text, / {8}compat:\n {10}supportsReasoningEffort: true\n {8}models:/);
  assert.deepEqual(
    built.compatChanges,
    [{ provider: 'alpha', desired: true }],
    '应记录协议开关的自动变更',
  );
});

test('openai-responses 协议下的 supportsReasoningEffort 会被移除并给出提醒', () => {
  const { built, reparsed } = build(FIXTURE, {
    edits: [
      {
        provider: 'beta',
        model: '[beta]model',
        input: 'text+image',
        reasoning: { mode: 'levels', levels: [{ level: 'low', wire: 'low' }] },
      },
    ],
  });
  const beta = editor.providerConfigOf(reparsed).beta;
  assert.equal(beta.compat.supportsReasoningEffort, undefined);
  assert.equal(beta.compat.otherFlag, 1, 'compat 中其他键必须保留');
  assert.equal(beta.models[0].input[1], 'image');
  assert.equal(built.warnings.length, 1);
  assert.match(built.warnings[0], /openai-responses/);
});

test('compat 块只剩该开关时会被整体移除', () => {
  const text = FIXTURE.replace(
    '          supportsReasoningEffort: true\n          otherFlag: 1\n',
    '          supportsReasoningEffort: true\n',
  );
  const { reparsed, built } = build(text, {
    edits: [
      { provider: 'beta', model: '[beta]model', input: 'inherit', reasoning: { mode: 'levels', levels: [{ level: 'high', wire: 'high' }] } },
    ],
  });
  assert.equal(editor.providerConfigOf(reparsed).beta.compat, undefined);
  const betaSection = built.text.slice(built.text.indexOf('      beta:'));
  assert.ok(!betaSection.includes('compat:'), '空的 compat 块应被整体移除');
  assert.ok(betaSection.includes('- id: "[beta]model"'), '模型本身必须保留');
});

test('非法档位组合会被拒绝', () => {
  assert.throws(
    () => build(FIXTURE, { edits: [{ provider: 'alpha', model: 'alpha-text', input: 'inherit', reasoning: { mode: 'levels', levels: [{ level: 'off', wire: null }] } }] }),
    /除 off 之外至少需要一个档位/,
  );
  assert.throws(
    () => build(FIXTURE, { edits: [{ provider: 'alpha', model: 'alpha-text', input: 'inherit', reasoning: { mode: 'levels', levels: [{ level: 'high', wire: null }] } }] }),
    /必须填写线上取值/,
  );
  assert.throws(
    () => build(FIXTURE, { edits: [{ provider: 'alpha', model: 'alpha-text', input: 'inherit', reasoning: { mode: 'levels', levels: [{ level: 'ultra', wire: 'x' }] } }] }),
    /未知的思考档位/,
  );
  assert.throws(
    () => build(FIXTURE, { edits: [{ provider: 'alpha', model: 'nope', input: 'inherit' }] }),
    /找不到模型/,
  );
});

test('打开/关闭对应 sed 风格的差异可读', () => {
  const { built } = build(FIXTURE, {
    edits: [{ provider: 'alpha', model: 'alpha-text', input: 'text+image', reasoning: { mode: 'inherit' } }],
  });
  const diff = unifiedDiff(FIXTURE, built.text, { labelA: 'before', labelB: 'after' });
  assert.match(diff, /^--- before/m);
  assert.match(diff, /^\+ {14}- image$/m);
});

test('真实配置文件可被解析、扫描并生成通过校验的预览（只读，不写盘）', (t) => {
  const candidates = require('../src/server').candidateConfigPaths();
  const real = candidates.find((candidate) => fs.existsSync(candidate) && /cordis\.patch\.yml$/.test(candidate));
  if (!real) {
    t.skip('未找到真实的 cordis.patch.yml');
    return;
  }
  const text = fs.readFileSync(real, 'utf8');
  const parsed = yaml.load(text);
  const scanResult = editor.scan(text);
  assert.deepEqual(scanResult.errors, [], `${real} 扫描失败`);
  assert.ok(scanResult.providers.length >= 5, `应识别出多个 provider，实际 ${scanResult.providers.length}`);

  const target = scanResult.providers.find((provider) => provider.models.length > 0);
  const model = target.models.find((item) => item.fields.has('input')) || target.models[0];
  const built = editor.buildEdit(text, parsed, {
    edits: [
      {
        provider: target.id,
        model: model.id,
        input: model.fields.has('input') ? 'text+image' : 'text+image',
        reasoning: { mode: 'levels', levels: [{ level: 'off', wire: null }, { level: 'low', wire: 'low' }, { level: 'medium', wire: 'medium' }, { level: 'high', wire: 'high' }] },
      },
    ],
  });
  const preimageErrors = verifyPreimage(editor.splitLines(text), editor.splitLines(built.text), built.ops);
  assert.deepEqual(preimageErrors, []);
  assert.ok(deepEqual(yaml.load(built.text), built.expected), '真实文件上的语义校验失败');
  assert.ok(built.text.endsWith('\n') === text.endsWith('\n'), '文件结尾换行风格应一致');
});
