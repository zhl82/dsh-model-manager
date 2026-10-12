'use strict';

/**
 * 端到端自检（默认只读真实配置，写入发生在临时副本上）：
 * 复制真实 cordis.patch.yml → 启动临时服务 → 保存 → 校验文件内容 → 恢复备份。
 *
 * 运行：node tools/e2e-check.js
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const yaml = require('../vendor/js-yaml.js');
const { createServer, resolveConfigPath } = require('../src/server');
const editor = require('../src/editor');

const results = [];
function check(name, condition, detail = '') {
  results.push({ name, ok: Boolean(condition), detail });
  console.log(`${condition ? '✔' : '✖'} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function json(port, route, body) {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, payload: await response.json() };
}

async function main() {
  const source = resolveConfigPath(process.argv[2]);
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mm-e2e-'));
  const target = path.join(workDir, 'cordis.patch.yml');
  fs.copyFileSync(source, target);
  const originalText = fs.readFileSync(target, 'utf8');
  console.log(`真实配置（只读取）：${source}`);
  console.log(`写入目标（临时副本）：${target}\n`);

  const app = createServer({ config: target });
  const log = console.log;
  console.log = () => {};
  const port = await app.listen(0);
  console.log = log;

  try {
    const state = await json(port, '/api/state');
    check('读取状态成功', state.payload.ok === true, `${state.payload.providers.length} 个 provider`);
    const fingerprint = state.payload.fingerprint;

    // 选一个 openai-completions 的 provider 做真实写入
    const provider = state.payload.providers.find((item) => item.supportsEffortProtocol && item.models.some((m) => m.editable));
    const model = provider.models.find((m) => m.editable);
    const edit = {
      provider: provider.id,
      model: model.id,
      input: 'text+image',
      reasoning: {
        mode: 'levels',
        levels: [{ level: 'off', wire: null }, { level: 'low', wire: 'low' }, { level: 'medium', wire: 'medium' }, { level: 'high', wire: 'high' }],
      },
    };
    console.log(`\n测试编辑：${provider.id}/${model.id}\n`);

    const preview = await json(port, '/api/preview', { edits: [edit], fingerprint, autoCompat: true });
    check('预览成功且不写盘', preview.payload.ok === true && fs.readFileSync(target, 'utf8') === originalText);
    check('预览包含 input 与 image 行', /\+.*input:/.test(preview.payload.diff) && /\+.*- image/.test(preview.payload.diff));
    check('预览注明自动变更项', preview.payload.notes.length > 0, preview.payload.notes.join(' | ').slice(0, 90));

    const save = await json(port, '/api/save', { edits: [edit], fingerprint, autoCompat: true });
    check('保存成功', save.payload.ok === true && save.payload.saved === true);
    check('生成了备份', Boolean(save.payload.backup) && fs.existsSync(save.payload.backup), save.payload.backup);

    const after = fs.readFileSync(target, 'utf8');
    check('备份内容等于写入前的文件', fs.readFileSync(save.payload.backup, 'utf8') === originalText);
    check('写入后文件变大（新增字段）', after.length > originalText.length, `${originalText.length} → ${after.length} 字节`);
    check('原文件注释仍保留', after.startsWith('# Your patch layer for this dsh profile'));

    const parsedAfter = yaml.load(after);
    const providersAfter = editor.providerConfigOf(parsedAfter);
    const modelAfter = providersAfter[provider.id].models.find((m) => m.id === model.id);
    check('模型已声明图片输入', JSON.stringify(modelAfter.input) === JSON.stringify(['text', 'image']), JSON.stringify(modelAfter.input));
    check(
      '模型已声明四档思考',
      JSON.stringify(modelAfter.reasoningEfforts) === JSON.stringify({ off: null, low: 'low', medium: 'medium', high: 'high' }),
      JSON.stringify(modelAfter.reasoningEfforts),
    );
    check('provider 已具备 thinking 协议开关', providersAfter[provider.id].compat && providersAfter[provider.id].compat.supportsReasoningEffort === true);

    const newState = await json(port, '/api/state');
    const again = await json(port, '/api/preview', { edits: [edit], fingerprint: newState.payload.fingerprint, autoCompat: true });
    check('重复提交相同改动无差异（幂等）', again.payload.ok === true && again.payload.diff === '');

    const stale = await json(port, '/api/save', { edits: [edit], fingerprint, autoCompat: true });
    check('收到过期指纹时拒绝写入（冲突保护）', stale.status === 409 && stale.payload.ok === false, stale.payload.error.slice(0, 40));

    const backups = await json(port, '/api/backups');
    const name = path.basename(save.payload.backup);
    check('备份列表可见', backups.payload.backups.some((item) => item.name === name));

    const restore = await json(port, '/api/restore', { backup: name });
    check('恢复成功', restore.payload.ok === true);
    check('恢复后与原始文件逐字节一致', fs.readFileSync(target, 'utf8') === originalText);
  } finally {
    app.server.close();
    fs.rmSync(workDir, { recursive: true, force: true });
  }

  const failed = results.filter((item) => !item.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 项通过`);
  if (failed.length > 0) {
    console.log(`失败：${failed.map((item) => item.name).join('、')}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`端到端自检异常：${error.stack}`);
  process.exitCode = 1;
});
