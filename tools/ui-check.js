'use strict';

/**
 * 可选的开发期界面自检：用本机 Chrome + puppeteer-core 打开界面，
 * 收集控制台错误并截图。运行：
 *   node tools/ui-check.js [url] [输出图片]
 * 需要本机已安装 Chrome；puppeteer-core 默认复用 DSH desktop profile 里的副本。
 */

const fs = require('node:fs');
const path = require('node:path');

const URL_TARGET = process.argv[2] || 'http://127.0.0.1:8791/';
const OUT = process.argv[3] || path.join(__dirname, '..', 'ui-check.png');

const PUPPETEER_CANDIDATES = [
  process.env.PUPPETEER_CORE_PATH,
  'C:/Users/Zhang Lei/.dsh/profiles/desktop/node_modules/puppeteer-core',
  'C:/Users/Zhang Lei/.dsh/profiles/web/node_modules/puppeteer-core',
].filter(Boolean);

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].filter(Boolean);

function firstExisting(list) {
  for (const item of list) {
    if (fs.existsSync(item)) return item;
  }
  return null;
}

async function main() {
  const puppeteerPath = firstExisting(PUPPETEER_CANDIDATES);
  const chromePath = firstExisting(CHROME_CANDIDATES);
  if (!puppeteerPath || !chromePath) {
    console.error(`跳过：找不到 puppeteer-core(${puppeteerPath}) 或 Chrome(${chromePath})`);
    process.exitCode = 2;
    return;
  }

  const puppeteer = require(puppeteerPath);
  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--window-size=1680,1000'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1680, height: 1000 });

  const messages = [];
  page.on('console', (msg) => messages.push(`[${msg.type()}] ${msg.text()}`));
  page.on('pageerror', (error) => messages.push(`[pageerror] ${error.message}`));

  await page.goto(URL_TARGET, { waitUntil: 'networkidle2', timeout: 30000 });
  await page.waitForSelector('#providerList li', { timeout: 15000 });

  const summary = await page.evaluate(() => ({
    providers: document.querySelectorAll('#providerList li').length,
    activeProvider: (document.querySelector('#providerList li.active') || {}).textContent || null,
    rows: document.querySelectorAll('#modelTable tbody tr').length,
    selects: document.querySelectorAll('#modelTable select').length,
    status: document.getElementById('status').textContent,
    path: document.getElementById('configPath').textContent,
  }));

  // 交互自检（全程只读：只调用 /api/preview，不点「写入配置」）
  const interaction = {};
  interaction.saveDisabledBefore = await page.$eval('#btnSave', (node) => node.disabled);

  const firstModel = await page.$eval('#modelTable tbody tr', (row) => {
    const select = row.querySelector('select[data-role="input"]');
    return { provider: select.dataset.provider, model: select.dataset.model, before: select.value };
  });
  interaction.firstModel = firstModel;

  await page.select(
    '#modelTable tbody tr select[data-role="input"]',
    firstModel.before === 'text+image' ? 'text' : 'text+image',
  );
  await page.waitForFunction(() => !document.getElementById('btnSave').disabled, { timeout: 5000 });
  interaction.dirtyInfo = await page.$eval('#dirtyInfo', (node) => node.textContent);
  interaction.saveEnabledAfterChange = await page.$eval('#btnSave', (node) => !node.disabled);

  await page.click('#btnPreview');
  await page.waitForSelector('#diffDialog[open]', { timeout: 10000 });
  interaction.diffSummary = await page.$eval('#diffSummary', (node) => node.textContent.split('\n')[0]);
  interaction.diffHasInputBlock = await page.$eval('#diffBody', (node) => /\+.*input:/.test(node.textContent));
  interaction.diffHasImageLine = await page.$eval('#diffBody', (node) => /\+.*- image/.test(node.textContent));
  await page.click('#diffDialog button[data-close="diffDialog"]');

  await page.click('#btnResetAll');
  await page.waitForFunction(() => document.getElementById('btnSave').disabled, { timeout: 5000 });
  interaction.resetCleared = await page.$eval('#dirtyInfo', (node) => node.textContent);

  await page.click('#btnBackups');
  await page.waitForSelector('#backupDialog[open]', { timeout: 10000 });
  interaction.backupDialog = await page.$eval('#backupList', (node) => node.textContent.trim().slice(0, 60));
  await page.click('#backupDialog button[data-close="backupDialog"]');

  await page.screenshot({ path: OUT, fullPage: false });
  await browser.close();

  console.log(JSON.stringify({ ...summary, interaction, messages, screenshot: OUT }, null, 2));
  if (messages.some((line) => line.startsWith('[pageerror]') || line.startsWith('[error]'))) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`界面自检失败：${error.message}`);
  process.exitCode = 1;
});
