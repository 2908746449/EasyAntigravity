const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, exec } = require('child_process');
const WebSocket = require('ws');

// 双击 exe 会挂控制台：windowsHide 重启自身并退出，避免黑框
if (process.platform === 'win32' && !process.env.EASYAG_NOCONSOLE) {
  try {
    const child = spawn(process.execPath, process.argv.slice(1), {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: Object.assign({}, process.env, {
        EASYAG_NOCONSOLE: '1',
        NODE_NO_WARNINGS: '1'
      })
    });
    child.unref();
    process.exit(0);
  } catch (e) {
    process.env.EASYAG_NOCONSOLE = '1';
  }
}

try {
  process.removeAllListeners('warning');
  process.on('warning', () => {});
  process.env.NODE_NO_WARNINGS = '1';
} catch (e) {}

const GUI_PORT = 19823;
const CDP_PORT = 9333;

// pkg 打包后 __dirname 指向虚拟内存，需锚定 exe 实际所在目录
const ROOT_DIR = process.pkg ? path.dirname(process.execPath) : __dirname;
const HTML_FILE = path.join(ROOT_DIR, 'index.html');

const APP_DIR = path.join(process.env.LOCALAPPDATA, 'Programs', 'antigravity');
const APP_EXE = path.join(APP_DIR, 'Antigravity.exe');
const BACKUP_DIR = path.join(ROOT_DIR, 'backup');
const BACKUP_DLL = path.join(BACKUP_DIR, 'version.dll');
const BACKUP_JSON = path.join(BACKUP_DIR, 'config.json');
const TARGET_DLL = path.join(APP_DIR, 'version.dll');
const TARGET_JSON = path.join(APP_DIR, 'config.json');

const DICT_DIR = path.join(ROOT_DIR, 'dicts');
const RULES_FILE = path.join(ROOT_DIR, 'danger-rules.json');
const BACKUP_RULES = path.join(BACKUP_DIR, 'danger-rules.json');

let state = {
  port: 7890,
  autoAccept: true,
  blockDangerous: true,
  preferOption: 4,
  enableI18n: true,
  dictEntries: 0,
  patchOk: false,
  clientRunning: false,
  dangerRulesTotal: 0,
  dangerRulesOn: 0,
  approveCount: 0,
  blockCount: 0
};

const DEFAULT_DANGER_RULES = [
  { id: 'rm-rf', name: '递归强制删除', pattern: '\\brm\\s+(-[a-zA-Z]*r[a-zA-Z]*f|--force)', flags: 'i', enabled: true },
  { id: 'windows-del', name: 'Windows 强制删除', pattern: '\\b(del|rd|rmdir)\\s+.*\\/[sqf]', flags: 'i', enabled: true },
  { id: 'disk-wipe', name: '磁盘破坏', pattern: '\\b(format|diskpart|mkfs|wipefs|shred)\\b', flags: 'i', enabled: true },
  { id: 'sql-drop', name: '数据库删除', pattern: '\\bdrop\\s+(database|table)\\b', flags: 'i', enabled: true },
  { id: 'git-force-push', name: 'Git 强制推送', pattern: '\\bgit\\s+push\\s+.*(-f|--force)\\b', flags: 'i', enabled: true },
  { id: 'shutdown', name: '关机/停止计算机', pattern: '\\b(shutdown|stop-computer)\\b', flags: 'i', enabled: true }
];

let dangerRules = { version: 1, enabled: true, rules: DEFAULT_DANGER_RULES };

function loadDangerRules() {
  const tryPaths = [RULES_FILE, BACKUP_RULES];
  for (const p of tryPaths) {
    if (!fs.existsSync(p)) continue;
    try {
      const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
      if (Array.isArray(data.rules)) {
        dangerRules = {
          version: data.version || 1,
          enabled: data.enabled !== false,
          rules: data.rules.filter(r => r && r.pattern)
        };
        // 自愈：主文件缺失时从备份写回
        if (p === BACKUP_RULES && !fs.existsSync(RULES_FILE)) {
          try { fs.copyFileSync(BACKUP_RULES, RULES_FILE); } catch (e) {}
        }
        break;
      }
    } catch (e) {}
  }
  if (!dangerRules.rules || !dangerRules.rules.length) {
    dangerRules = { version: 1, enabled: true, rules: DEFAULT_DANGER_RULES };
  }
  const on = dangerRules.rules.filter(r => r.enabled !== false).length;
  state.dangerRulesTotal = dangerRules.rules.length;
  state.dangerRulesOn = dangerRules.enabled === false ? 0 : on;
  return dangerRules;
}

function getActiveDangerPatterns() {
  if (dangerRules.enabled === false) return [];
  return dangerRules.rules
    .filter(r => r.enabled !== false)
    .map(r => ({ id: r.id || 'rule', name: r.name || r.id || 'rule', pattern: r.pattern, flags: r.flags || 'i' }));
}

let translationDict = {};
function loadDictionaries() {
  translationDict = {};
  const files = ['ui_v2.json', 'common.json'];
  files.forEach(f => {
    const fullPath = path.join(DICT_DIR, f);
    if (fs.existsSync(fullPath)) {
      try {
        const data = JSON.parse(fs.readFileSync(fullPath, 'utf-8'));
        Object.assign(translationDict, data);
      } catch (e) {}
    }
  });
  state.dictEntries = Object.keys(translationDict).length;
}

let sseClients = [];

function logToGUI(category, message, cls = '') {
  const payload = JSON.stringify({ category, message, cls });
  sseClients.forEach(res => res.write(`data: ${payload}\n\n`));
}

function pushCounters() {
  const payload = JSON.stringify({
    counters: true,
    approveCount: state.approveCount,
    blockCount: state.blockCount
  });
  sseClients.forEach(res => res.write(`data: ${payload}\n\n`));
}

function ensureProxyWatchdog() {
  if (!fs.existsSync(APP_DIR)) return false;
  let restored = false;
  if (!fs.existsSync(TARGET_DLL) && fs.existsSync(BACKUP_DLL)) {
    fs.copyFileSync(BACKUP_DLL, TARGET_DLL);
    restored = true;
  }
  if (!fs.existsSync(TARGET_JSON) && fs.existsSync(BACKUP_JSON)) {
    fs.copyFileSync(BACKUP_JSON, TARGET_JSON);
    restored = true;
  }
  if (fs.existsSync(BACKUP_JSON)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(BACKUP_JSON, 'utf-8'));
      if (cfg.proxy?.port) state.port = cfg.proxy.port;
    } catch (e) {}
  }
  state.patchOk = fs.existsSync(TARGET_DLL) && fs.existsSync(TARGET_JSON);
  return restored;
}

function syncProxyPort(newPort) {
  state.port = newPort;
  [BACKUP_JSON, TARGET_JSON].forEach(file => {
    if (fs.existsSync(file)) {
      try {
        const cfg = JSON.parse(fs.readFileSync(file, 'utf-8'));
        if (!cfg.proxy) cfg.proxy = {};
        cfg.proxy.port = newPort;
        fs.writeFileSync(file, JSON.stringify(cfg, null, 2), 'utf-8');
      } catch (e) {}
    }
  });
  logToGUI('PROXY', `SOCKS5 端口已同步更新为: ${newPort}`, 'tag-proxy');
}

function generateMasterInjectScript() {
  const dictJSON = JSON.stringify(translationDict);
  const patternsJSON = JSON.stringify(getActiveDangerPatterns());
  return `(() => {
    window.__ea_config = Object.assign(window.__ea_config || {}, {
      preferOption: ${state.preferOption},
      blockDangerous: ${state.blockDangerous},
      autoAccept: ${state.autoAccept},
      enableI18n: ${state.enableI18n}
    });
    window.__ea_dict = ${dictJSON};
    window.__ea_danger_patterns = ${patternsJSON};

    if (window.__ea_engine_running) return;
    window.__ea_engine_running = true;

    const DANGEROUS_PATTERNS = (window.__ea_danger_patterns || []).map(r => {
      try { return { id: r.id, name: r.name, re: new RegExp(r.pattern, r.flags || 'i') }; }
      catch (e) { return null; }
    }).filter(Boolean);

    function realClick(el) {
      const opts = { bubbles: true, cancelable: true, view: window };
      el.dispatchEvent(new PointerEvent('pointerdown', opts));
      el.dispatchEvent(new MouseEvent('mousedown', opts));
      el.dispatchEvent(new PointerEvent('pointerup', opts));
      el.dispatchEvent(new MouseEvent('mouseup', opts));
      el.dispatchEvent(new MouseEvent('click', opts));
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
    }

    function norm(s) {
      return String(s || '').toLowerCase().replace(/\\s+/g, ' ').trim();
    }

    function isSubmitLabel(s) {
      const t = norm(s);
      if (!t || t.length > 40) return false;
      return (
        t === 'submit' ||
        t.startsWith('submit') ||
        t === '提交' ||
        t.includes('提交') ||
        t === 'confirm' ||
        t.startsWith('confirm') ||
        t === '确认' ||
        t.startsWith('确认') ||
        t === 'allow' ||
        t === '允许' ||
        t.includes('submit ↵') ||
        t.includes('提交 ↵') ||
        t.includes('submit enter')
      );
    }

    function matchOptionEl(card, optIdx) {
      const idx = Number(optIdx) || 4;
      const patterns = {
        1: [/^1[\\s\\.\\:：\\-]/, /this time/, /仅本次/, /这一次/, /本次/],
        2: [/^2[\\s\\.\\:：\\-]/, /this session/, /对话中/, /本次会话/],
        3: [/^3[\\s\\.\\:：\\-]/, /this project/, /项目中/, /本项目/],
        4: [/^4[\\s\\.\\:：\\-]/, /always allow/, /始终允许/, /全局/, /\\balways\\b/]
      };
      const pats = patterns[idx] || patterns[4];
      const items = Array.from(card.querySelectorAll('label, [role="radio"], [role="option"], button, div, span, li'));
      for (const el of items) {
        const tx = norm(el.innerText);
        if (!tx || tx.length > 80) continue;
        if (pats.some(p => p.test(tx))) return el;
      }
      for (const el of items) {
        const tx = norm(el.innerText);
        if (tx === String(idx) || new RegExp('^' + idx + '[\\\\s\\\\.\\\\:：\\\\-]').test(tx)) return el;
      }
      return null;
    }

    function clip(s, n) {
      s = String(s || '').replace(/\\s+/g, ' ').trim();
      if (s.length <= n) return s;
      return s.slice(0, n - 1) + '…';
    }

    function extractRequestSummary(card) {
      if (!card) return '';
      const parts = [];
      // 代码/命令块优先
      const codes = Array.from(card.querySelectorAll('pre, code, [class*="command"], [class*="code"], [data-testid*="command"]'));
      for (const c of codes) {
        const t = (c.innerText || c.textContent || '').trim();
        if (t && t.length > 1 && t.length < 500) {
          parts.push(t);
          if (parts.length >= 2) break;
        }
      }
      // 文件路径类
      const paths = Array.from(card.querySelectorAll('[class*="path"], [class*="file"], [title]'));
      for (const p of paths) {
        const t = (p.getAttribute('title') || p.innerText || '').trim();
        if (t && /[\\\\/]|:\\\\/.test(t) && t.length < 200) {
          parts.push(t);
          break;
        }
      }
      // 描述段落：排除按钮/选项行
      if (parts.length === 0) {
        const texts = Array.from(card.querySelectorAll('p, span, div'))
          .map(el => (el.innerText || '').trim())
          .filter(t => t.length > 8 && t.length < 180)
          .filter(t => !isSubmitLabel(t))
          .filter(t => !/^(1|2|3|4)[\\s\\.\\:：\\-]/.test(norm(t)))
          .filter(t => !/^(submit|提交|confirm|确认|allow|允许|run|运行)/i.test(t));
        if (texts.length) {
          // 取最长的一段作为请求描述
          texts.sort((a, b) => b.length - a.length);
          parts.push(texts[0]);
        }
      }
      const uniq = [];
      for (const p of parts) {
        const v = clip(p, 160);
        if (v && uniq.indexOf(v) < 0) uniq.push(v);
      }
      return uniq.join(' | ');
    }

    function translateDOM(root) {
      if (!window.__ea_config.enableI18n || !window.__ea_dict) return;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        const text = node.nodeValue.trim();
        if (text && window.__ea_dict[text]) {
          node.nodeValue = node.nodeValue.replace(text, window.__ea_dict[text]);
        }
      }
      const elements = root.querySelectorAll ? root.querySelectorAll('[placeholder], [title]') : [];
      elements.forEach(el => {
        const ph = el.getAttribute('placeholder');
        if (ph && window.__ea_dict[ph]) el.setAttribute('placeholder', window.__ea_dict[ph]);
        const title = el.getAttribute('title');
        if (title && window.__ea_dict[title]) el.setAttribute('title', window.__ea_dict[title]);
      });
    }

    setInterval(() => {
      function scan(doc) {
        translateDOM(doc);
        if (!window.__ea_config.autoAccept) return;

        const pageText = norm(doc.body ? doc.body.innerText : '');
        const permHit = /allow reading|yes, allow|允许访问|allow access|read files|file access|permission|权限请求|请求权限|访问文件/.test(pageText);
        if (permHit) {
          const cards = Array.from(doc.querySelectorAll('div, section, [role="dialog"], [role="alertdialog"]'));
          for (const card of cards) {
            const t = norm(card.innerText);
            if (!t || t.length > 2500) continue;
            if (!/allow reading|yes, allow|允许访问|allow access|permission|权限|read files|访问文件/.test(t)) continue;
            const submitBtn = Array.from(card.querySelectorAll('button, [role="button"], div[role="button"], input[type="submit"]'))
              .find(b => isSubmitLabel(b.innerText || b.value || b.getAttribute('aria-label')));

            if (submitBtn && !submitBtn.hasAttribute('data-ea-ok')) {
              const optIdx = (window.__ea_config && window.__ea_config.preferOption) || 4;
              const targetOpt = matchOptionEl(card, optIdx);
              if (targetOpt) realClick(targetOpt);
              submitBtn.setAttribute('data-ea-ok', 'true');
              realClick(submitBtn);
              const summary = extractRequestSummary(card) || '(未识别到请求正文)';
              console.log('[EA_AA] 批准权限 · 选项[' + optIdx + '] · ' + summary);
              return;
            }
          }
        }

        const kws = ['run', 'accept', 'continue', 'always allow', 'allow', '运行', '接受', '继续', '始终允许', '允许', '确认', '提交'];
        for (const btn of Array.from(doc.querySelectorAll('button, [role="button"]'))) {
          const txt = norm(btn.innerText || btn.getAttribute('aria-label'));
          if (!txt || txt.length > 24) continue;
          if (kws.some(k => txt === k || txt.startsWith(k))) {
            if (!btn.disabled && !btn.hasAttribute('data-ea-ok')) {
              const card = btn.closest('div[class*="card"], div[class*="container"]') || btn.parentElement?.parentElement;
              if (window.__ea_config.blockDangerous) {
                const codeBlock = card ? (card.querySelector('pre, code') || card) : null;
                const cmd = codeBlock ? (codeBlock.innerText || '').trim() : '';
                if (DANGEROUS_PATTERNS.some(r => r.re.test(cmd))) {
                  const hit = DANGEROUS_PATTERNS.find(r => r.re.test(cmd));
                  btn.setAttribute('data-ea-ok', 'blocked');
                  console.warn('[EA_ALERT] 拦截高危指令[' + (hit && hit.id) + ']: ' + cmd.slice(0, 80));
                  return;
                }
              }
              btn.setAttribute('data-ea-ok', 'true');
              realClick(btn);
              const summary = extractRequestSummary(card) || txt;
              console.log('[EA_AA] 放行 · ' + summary);
              return;
            }
          }
        }
      }

      scan(document);
      const iframes = document.querySelectorAll('iframe');
      iframes.forEach(f => {
        try { if (f.contentDocument) scan(f.contentDocument); } catch (e) {}
      });
    }, 800);
  })();`;
}

function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: 4000 }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
  });
}

const cdpSockets = new Map();

async function startCDPLoop() {
  while (state.clientRunning) {
    try {
      const targets = await httpGetJson(`http://127.0.0.1:${CDP_PORT}/json/list`);
      const valid = (targets || []).filter(t =>
        t && t.webSocketDebuggerUrl &&
        !String(t.url || '').startsWith('devtools://') &&
        !String(t.url || '').startsWith('data:text/html')
      );

      const aliveIds = new Set(valid.map(t => t.webSocketDebuggerUrl));

      // 关掉已失效的连接
      for (const [key, sock] of cdpSockets) {
        if (!aliveIds.has(key)) {
          try { sock.close(); } catch (e) {}
          cdpSockets.delete(key);
        }
      }

      for (const target of valid) {
        const key = target.webSocketDebuggerUrl;
        if (cdpSockets.has(key)) continue;

        const ws = new WebSocket(key);
        cdpSockets.set(key, ws);
        ws.on('open', () => {
          ws.send(JSON.stringify({ id: 1, method: 'Runtime.enable' }));
          ws.send(JSON.stringify({ id: 2, method: 'Runtime.evaluate', params: { expression: generateMasterInjectScript() } }));
        });
        ws.on('message', (data) => {
          try {
            const msg = JSON.parse(data.toString());
            if (msg.method === 'Runtime.consoleAPICalled') {
              const text = msg.params.args.map(a => a.value || '').join(' ');
              if (text.includes('[EA_AA]')) {
                state.approveCount += 1;
                logToGUI('AUTO-ACCEPT', text.replace('[EA_AA]', '').trim(), 'tag-aa');
                pushCounters();
              } else if (text.includes('[EA_ALERT]')) {
                state.blockCount += 1;
                logToGUI('SECURITY ALERT', text.replace('[EA_ALERT]', '').trim(), 'tag-alert');
                pushCounters();
              }
            }
          } catch (e) {}
        });
        ws.on('error', () => {
          cdpSockets.delete(key);
          try { ws.close(); } catch (e) {}
        });
        ws.on('close', () => {
          cdpSockets.delete(key);
        });
      }
    } catch (e) {}
    await new Promise(r => setTimeout(r, 2000));
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8'
};

const server = http.createServer((req, res) => {
  if (req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(fs.readFileSync(HTML_FILE));
  }
  if (req.url && req.url.startsWith('/assets/')) {
    const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/assets\//, '');
    const safe = path.normalize(rel).replace(/^(\.\.[\/\\])+/, '');
    const file = path.join(ROOT_DIR, 'assets', safe);
    if (!file.startsWith(path.join(ROOT_DIR, 'assets')) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404);
      return res.end('not found');
    }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    return res.end(fs.readFileSync(file));
  }
  if (req.url === '/api/danger-rules' && req.method === 'GET') {
    return res.end(JSON.stringify({
      path: RULES_FILE,
      enabled: dangerRules.enabled !== false,
      rules: dangerRules.rules,
      active: state.dangerRulesOn,
      total: state.dangerRulesTotal
    }));
  }
  if (req.url === '/api/danger-rules/reload' && req.method === 'POST') {
    loadDangerRules();
    logToGUI('SECURITY', `高危规则已重载: ${state.dangerRulesOn}/${state.dangerRulesTotal} 条生效`, 'tag-proxy');
    return res.end(JSON.stringify({ ok: true, active: state.dangerRulesOn, total: state.dangerRulesTotal }));
  }
  if (req.url === '/api/danger-rules/open' && req.method === 'POST') {
    try {
      if (!fs.existsSync(RULES_FILE) && fs.existsSync(BACKUP_RULES)) {
        fs.copyFileSync(BACKUP_RULES, RULES_FILE);
      }
      if (!fs.existsSync(RULES_FILE)) {
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ ok: false, error: 'rules file missing' }));
      }
      // explorer 用系统默认程序打开 json，比 cmd start 更稳
      spawn('explorer.exe', [RULES_FILE], { detached: true, stdio: 'ignore' }).unref();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: true, path: RULES_FILE }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: false, error: String(e.message || e) }));
    }
  }
  if (req.url === '/api/status') {
    ensureProxyWatchdog();
    return res.end(JSON.stringify(state));
  }
  if (req.url === '/api/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
    sseClients.push(res);
    req.on('close', () => { sseClients = sseClients.filter(c => c !== res); });
    return;
  }
  if (req.url === '/api/config' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const data = JSON.parse(body);

        if (data.port) {
          const portNum = parseInt(data.port, 10);
          if (portNum >= 1 && portNum <= 65535) {
            syncProxyPort(portNum);
          } else {
            logToGUI('PROXY', `非法端口输入 [${data.port}]，已忽略`, 'tag-warn');
          }
        }

        if (typeof data.autoAccept === 'boolean') state.autoAccept = data.autoAccept;
        if (typeof data.blockDangerous === 'boolean') state.blockDangerous = data.blockDangerous;
        if (typeof data.enableI18n === 'boolean') state.enableI18n = data.enableI18n;
        if (data.preferOption) state.preferOption = data.preferOption;

        res.end('ok');
      } catch (e) {
        res.writeHead(400);
        res.end('invalid json');
      }
    });
    return;
  }
  if (req.url === '/api/launch' && req.method === 'POST') {
    const restored = ensureProxyWatchdog();
    if (restored) logToGUI('PROXY', '检测到客户端更新抹除补丁，已自动从备份恢复！', 'tag-warn');
    else logToGUI('PROXY', '免 TUN 补丁校验通过', 'tag-proxy');

    if (state.enableI18n) logToGUI('I18N', `已装载汉化引擎 (${state.dictEntries} 条词条)`, 'tag-i18n');

    const child = spawn(APP_EXE, [`--remote-debugging-port=${CDP_PORT}`], { detached: true, stdio: 'ignore' });
    state.clientRunning = true;
    logToGUI('SYSTEM', '✓ Antigravity 已启动，代理注入与 CDP 接管就绪', 'tag-proxy');

    startCDPLoop();
    child.on('exit', () => {
      state.clientRunning = false;
      logToGUI('SYSTEM', 'Antigravity 客户端已关闭', 'tag-warn');
    });
    res.end('ok');
    return;
  }

  // 未知路由必须结束响应，避免前端 fetch 永久挂起
  res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ ok: false, error: 'not found', url: req.url }));
});

loadDictionaries();
loadDangerRules();

function writeCrashLog(msg) {
  try {
    fs.writeFileSync(path.join(ROOT_DIR, 'easyag-error.log'), String(msg), 'utf-8');
  } catch (e) {}
}

server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    // 已有实例在跑：打开已有控制台后正常退出，避免双击闪退
    try {
      exec(`start msedge --app=http://127.0.0.1:${GUI_PORT} --force-dark-mode`);
    } catch (e) {}
    process.exit(0);
  }
  writeCrashLog(err && err.stack ? err.stack : String(err));
  process.exit(1);
});

process.on('uncaughtException', (err) => {
  writeCrashLog(err && err.stack ? err.stack : String(err));
});

server.listen(GUI_PORT, '127.0.0.1', () => {
  ensureProxyWatchdog();
  logToGUI('SECURITY', `高危规则已加载: ${state.dangerRulesOn}/${state.dangerRulesTotal} 条生效`, 'tag-proxy');
  // 使用 Edge 应用模式；favicon 为 data-URI，任务栏/标题栏图标跟随页面
  exec(`start msedge --app=http://127.0.0.1:${GUI_PORT} --force-dark-mode`);
});
