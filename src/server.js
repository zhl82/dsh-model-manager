'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const yaml = require('../vendor/js-yaml.js');
const editor = require('./editor');
const { unifiedDiff, diffStat } = require('./diff');
const { verifyPreimage, describeDiff } = require('./verify');
const { deepEqual, formatTimestamp } = require('./util');

const ROOT = path.resolve(__dirname, '..');
const WEB_DIR = path.join(ROOT, 'web');
const BACKUP_DIR = path.join(ROOT, 'backups');
const HOST = '127.0.0.1';

// ------------------------------------------------------------ config discovery

function candidateConfigPaths() {
  const home = os.homedir();
  const dshHome = process.env.DSH_HOME || path.join(home, '.dsh');
  const candidates = [];
  if (process.env.DSH_MODEL_MANAGER_CONFIG) candidates.push(process.env.DSH_MODEL_MANAGER_CONFIG);
  if (process.env.DSH_PATCH_FILE) candidates.push(process.env.DSH_PATCH_FILE);
  for (const profile of ['desktop', 'web']) {
    candidates.push(path.join(dshHome, 'profiles', profile, 'cordis.patch.yml'));
  }
  candidates.push(path.join(dshHome, 'settings.yaml'));
  return candidates;
}

function resolveConfigPath(explicit) {
  if (explicit) {
    const resolved = path.resolve(explicit);
    if (!fs.existsSync(resolved)) throw new Error(`配置文件不存在：${resolved}`);
    return resolved;
  }
  const candidates = candidateConfigPaths();
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return path.resolve(candidate);
  }
  return path.resolve(candidates[candidates.length - 1]);
}

function fingerprintOf(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
}

function readConfig(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  const stat = fs.statSync(filePath);
  return { text, stat, fingerprint: fingerprintOf(text) };
}

// ------------------------------------------------------------------- view model

function inputModeOf(model) {
  const value = model.input;
  if (value === undefined || value === null) return { mode: 'inherit', raw: null, known: true };
  if (!Array.isArray(value)) return { mode: 'inherit', raw: value, known: false };
  const hasImage = value.includes('image');
  const onlyText = value.length > 0 && value.every((item) => item === 'text');
  if (hasImage) return { mode: 'text+image', raw: value, known: true };
  if (onlyText) return { mode: 'text', raw: value, known: true };
  return { mode: 'inherit', raw: value, known: false };
}

function reasoningOf(model) {
  const value = model.reasoningEfforts;
  if (value === undefined || value === null) return { mode: 'inherit', levels: [] };
  if (value === false) return { mode: 'false', levels: [] };
  if (typeof value !== 'object' || Array.isArray(value)) return { mode: 'inherit', levels: [] };
  const levels = editor.LEVELS.filter((level) => Object.prototype.hasOwnProperty.call(value, level)).map(
    (level) => ({ level, wire: value[level] === null || value[level] === undefined ? null : String(value[level]) }),
  );
  if (levels.length === 0) return { mode: 'inherit', levels: [] };
  return { mode: 'levels', levels };
}

function buildState(filePath) {
  const { text, stat, fingerprint } = readConfig(filePath);
  const scanResult = editor.scan(text);
  let providers = {};
  let parseError = null;
  try {
    const parsed = yaml.load(text);
    providers = editor.providerConfigOf(parsed) || {};
  } catch (error) {
    parseError = `YAML 解析失败：${error.message}`;
  }

  const ids = [];
  for (const provider of scanResult.providers) if (!ids.includes(provider.id)) ids.push(provider.id);
  for (const id of Object.keys(providers)) if (!ids.includes(id)) ids.push(id);

  const out = [];
  for (const id of ids) {
    const scanProvider = scanResult.providers.find((item) => item.id === id) || null;
    const config = providers[id] || {};
    const modelIds = [];
    if (scanProvider) for (const model of scanProvider.models) if (!modelIds.includes(model.id)) modelIds.push(model.id);
    for (const model of Array.isArray(config.models) ? config.models : []) {
      if (model && model.id && !modelIds.includes(model.id)) modelIds.push(model.id);
    }

    const models = modelIds.map((modelId) => {
      const scanModel = scanProvider ? scanProvider.models.find((item) => item.id === modelId) : null;
      const modelConfig = (Array.isArray(config.models) ? config.models : []).find(
        (item) => item && item.id === modelId,
      ) || {};
      const inputInfo = inputModeOf(modelConfig);
      return {
        id: modelId,
        name: modelConfig.name || modelId,
        contextWindow: modelConfig.contextWindow === undefined ? null : modelConfig.contextWindow,
        maxTokens: modelConfig.maxTokens === undefined ? null : modelConfig.maxTokens,
        input: inputInfo.mode,
        inputRaw: inputInfo.raw,
        inputKnown: inputInfo.known,
        reasoning: reasoningOf(modelConfig),
        editable: Boolean(scanModel),
        line: scanModel ? scanModel.itemLine + 1 : null,
      };
    });

    out.push({
      id,
      displayName: config.displayName || id,
      api: config.api || null,
      baseURL: config.baseURL || null,
      apiKeyEnv: config.apiKeyEnv || null,
      effortSwitch:
        config.compat && typeof config.compat === 'object'
          ? Boolean(config.compat[editor.EFFORT_SWITCH])
          : false,
      supportsEffortProtocol: config.api === editor.EFFORT_PROTOCOL,
      editable: Boolean(scanProvider),
      models,
    });
  }

  return {
    path: filePath,
    exists: true,
    fingerprint,
    mtime: stat.mtime.toISOString(),
    size: stat.size,
    eol: editor.detectEol(text),
    entryFound: Boolean(scanResult.entry),
    scanErrors: scanResult.errors,
    parseError,
    providers: out,
    levels: editor.LEVELS,
    candidates: candidateConfigPaths().map((item) => path.resolve(item)),
  };
}

// ---------------------------------------------------------------- write actions

function listBackups() {
  if (!fs.existsSync(BACKUP_DIR)) return [];
  return fs
    .readdirSync(BACKUP_DIR)
    .filter((name) => name.endsWith('.bak'))
    .map((name) => {
      const full = path.join(BACKUP_DIR, name);
      const stat = fs.statSync(full);
      return { name, path: full, size: stat.size, mtime: stat.mtime.toISOString() };
    })
    .sort((a, b) => (a.mtime < b.mtime ? 1 : -1));
}

function backupFile(filePath) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const base = path.basename(filePath);
  let target = path.join(BACKUP_DIR, `${base}.${formatTimestamp()}.bak`);
  // 同一毫秒内连续备份时也必须各自独立，否则恢复会读到被覆盖的备份
  let suffix = 1;
  while (fs.existsSync(target)) {
    target = path.join(BACKUP_DIR, `${base}.${formatTimestamp()}-${suffix}.bak`);
    suffix += 1;
  }
  fs.copyFileSync(filePath, target);
  return target;
}

function atomicWrite(filePath, text) {
  const dir = path.dirname(filePath);
  const tmp = path.join(dir, `.${path.basename(filePath)}.tmp-${process.pid}-${Date.now()}`);
  fs.writeFileSync(tmp, text, 'utf8');
  try {
    fs.renameSync(tmp, filePath);
  } catch (error) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    throw error;
  }
}

/** Build, verify and optionally save an edit request. */
function processRequest(filePath, body, { save }) {
  const current = readConfig(filePath);
  if (body.fingerprint && body.fingerprint !== current.fingerprint) {
    return {
      status: 409,
      payload: {
        ok: false,
        error: '配置文件已被外部修改（可能改自 DSH 界面），请先「重新读取」再提交，避免覆盖别人的改动',
        fingerprint: current.fingerprint,
      },
    };
  }

  let parsed;
  try {
    parsed = yaml.load(current.text);
  } catch (error) {
    return { status: 400, payload: { ok: false, error: `原文件 YAML 解析失败，已中止：${error.message}` } };
  }

  let built;
  try {
    built = editor.buildEdit(current.text, parsed, {
      edits: body.edits,
      autoCompat: body.autoCompat !== false,
    });
  } catch (error) {
    return { status: 400, payload: { ok: false, error: error.message } };
  }

  const preimageErrors = verifyPreimage(editor.splitLines(current.text), editor.splitLines(built.text), built.ops);
  if (preimageErrors.length > 0) {
    return {
      status: 500,
      payload: { ok: false, error: '安全性检查失败：编辑区间外的内容发生了改动，已中止', details: preimageErrors },
    };
  }

  let newParsed;
  try {
    newParsed = yaml.load(built.text);
  } catch (error) {
    return { status: 500, payload: { ok: false, error: `生成的 YAML 无法解析，已中止：${error.message}` } };
  }

  if (!deepEqual(newParsed, built.expected)) {
    return {
      status: 500,
      payload: {
        ok: false,
        error: '语义校验失败：生成结果与预期不一致，已中止（未写入任何内容）',
        details: describeDiff(built.expected, newParsed, '$', [], 12),
      },
    };
  }

  const diff = unifiedDiff(current.text, built.text, {
    labelA: `${path.basename(filePath)} (当前)`,
    labelB: `${path.basename(filePath)} (修改后)`,
    context: 3,
  });
  const stat = diffStat(current.text, built.text);

  const payload = {
    ok: true,
    diff,
    added: stat.added,
    removed: stat.removed,
    notes: built.notes,
    warnings: built.warnings,
    changes: built.changes,
    compatChanges: built.compatChanges,
    saved: false,
  };

  if (!save) return { status: 200, payload };

  const backup = backupFile(filePath);
  atomicWrite(filePath, built.text);
  payload.saved = true;
  payload.backup = backup;
  payload.state = buildState(filePath);
  return { status: 200, payload };
}

// -------------------------------------------------------------------- HTTP glue

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const full = path.join(WEB_DIR, rel);
  if (!full.startsWith(WEB_DIR) || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return;
  }
  const type = CONTENT_TYPES[path.extname(full).toLowerCase()] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(fs.readFileSync(full));
}

function readBody(req, limitBytes = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (raw.trim().length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(new Error(`请求体不是合法 JSON：${error.message}`));
      }
    });
    req.on('error', reject);
  });
}

function createServer(options = {}) {
  let configPath = resolveConfigPath(options.config);

  /** 优雅关闭：停止接收新连接，然后退出进程。 */
  const shutdown = (reason) => {
    console.log(`正在关闭服务（${reason}）…`);
    server.close(() => process.exit(0));
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    // 兜底：仍有连接挂着时强制退出
    setTimeout(() => process.exit(0), 1000).unref();
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${HOST}`);
    try {
      if (req.method === 'GET' && url.pathname === '/api/state') {
        if (!fs.existsSync(configPath)) {
          sendJson(res, 404, { ok: false, error: `配置文件不存在：${configPath}`, path: configPath });
          return;
        }
        sendJson(res, 200, { ok: true, ...buildState(configPath) });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/shutdown') {
        sendJson(res, 200, { ok: true, message: '服务正在关闭，可以直接关闭此页面' });
        setTimeout(() => shutdown('界面请求关闭'), 150);
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/backups') {
        sendJson(res, 200, { ok: true, backups: listBackups(), backupDir: BACKUP_DIR });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/config') {
        const body = await readBody(req);
        try {
          configPath = resolveConfigPath(body.path);
        } catch (error) {
          sendJson(res, 400, { ok: false, error: error.message });
          return;
        }
        sendJson(res, 200, { ok: true, ...buildState(configPath) });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/preview') {
        const body = await readBody(req);
        const result = processRequest(configPath, body, { save: false });
        sendJson(res, result.status, result.payload);
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/save') {
        const body = await readBody(req);
        const result = processRequest(configPath, body, { save: true });
        sendJson(res, result.status, result.payload);
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/restore') {
        const body = await readBody(req);
        const name = path.basename(String(body.backup || ''));
        const full = path.join(BACKUP_DIR, name);
        if (!name || !full.startsWith(BACKUP_DIR) || !fs.existsSync(full)) {
          sendJson(res, 400, { ok: false, error: '备份文件不存在' });
          return;
        }
        const current = backupFile(configPath);
        atomicWrite(configPath, fs.readFileSync(full, 'utf8'));
        sendJson(res, 200, { ok: true, restoredFrom: full, safetyBackup: current, ...buildState(configPath) });
        return;
      }

      if (req.method === 'GET') {
        serveStatic(res, url.pathname);
        return;
      }

      sendJson(res, 405, { ok: false, error: '不支持的方法' });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error.message });
    }
  });

  server.on('listening', () => {
    const { port } = server.address();
    console.log(`DSH Model Capability Manager`);
    console.log(`  界面:  http://${HOST}:${port}`);
    console.log(`  配置:  ${configPath}`);
    console.log(`  备份:  ${BACKUP_DIR}`);
    console.log(`  关闭:  在界面点「关闭服务」，或按 Ctrl+C，或运行 stop.cmd`);
  });

  return {
    server,
    shutdown,
    listen(port) {
      return new Promise((resolve, reject) => {
        const onError = (error) => {
          server.removeListener('listening', onListening);
          reject(error);
        };
        const onListening = () => {
          server.removeListener('error', onError);
          resolve(server.address().port);
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, HOST);
      });
    },
    get configPath() {
      return configPath;
    },
  };
}

module.exports = { createServer, resolveConfigPath, buildState, processRequest, candidateConfigPaths, BACKUP_DIR };

if (require.main === module) {
  const args = process.argv.slice(2);
  const explicit = args.find((arg) => !arg.startsWith('--'));
  const portArg = args.find((arg) => arg.startsWith('--port='));
  const port = portArg ? Number(portArg.split('=')[1]) : Number(process.env.PORT || 8791);
  try {
    const app = createServer({ config: explicit });
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
      process.on(signal, () => app.shutdown(`收到 ${signal}`));
    }
    app.listen(port).catch((error) => {
      if (error.code === 'EADDRINUSE') {
        console.error(`端口 ${port} 已被占用：可能已经有一个实例在运行（可直接访问 http://${HOST}:${port}）。`);
        console.error(`如需换端口：node src/server.js --port=8792`);
        process.exit(1);
      }
      console.error(`启动失败：${error.message}`);
      process.exit(1);
    });
  } catch (error) {
    console.error(`启动失败：${error.message}`);
    process.exit(1);
  }
}
