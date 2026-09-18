/**
 * EasyAntigravity · macOS 适配版
 *
 * 原版：Windows 控制台（version.dll winsock 劫持 + CDP 注入 + 汉化 + 自动审批）
 * 本版：macOS 等价实现
 *   - 免 TUN 代理：DYLD 注入 libeasyag_proxy.dylib 劫持 libsystem connect()
 *                  （Windows 是 version.dll 劫持 winsock connect()，一一对应）
 *   - 界面汉化  ：CDP 注入词典（与原版一致）
 *   - 自动审批  ：CDP 注入引擎（与原版一致）
 *   - 高危拦截  ：danger-rules.json（与原版一致）
 *
 * 平台差异全部收敛在下面「平台层」区块，其余逻辑与原版保持同构。
 */

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn, exec, execFile } = require('child_process');
const WebSocket = require('ws');

const GUI_PORT = 19823;
const CDP_PORT = 9333;

const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';

/* 不再 pkg 打包，__dirname 就是真实目录 */
const ROOT_DIR = __dirname;
const LOCK_FILE = path.join(ROOT_DIR, 'easyag.lock');
const SUPPORT_DIR = path.join(os.homedir(), 'Library', 'Application Support', 'EasyAntigravity');
const GUI_PROFILE_DIR = path.join(SUPPORT_DIR, 'gui-profile');

/* ===================================================================== */
/* 平台层：应用定位                                                       */
/* ===================================================================== */
function findAppBundle() {
  if (IS_MAC) {
    const cands = [
      '/Applications/Antigravity.app',
      path.join(os.homedir(), 'Applications', 'Antigravity.app')
    ];
    for (const c of cands) if (fs.existsSync(c)) return c;
    return null;
  }
  if (IS_WIN) {
    const dir = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'antigravity');
    return fs.existsSync(dir) ? dir : null;
  }
  return null;
}

const APP_BUNDLE = findAppBundle();

const APP_EXE = APP_BUNDLE
  ? (IS_MAC ? path.join(APP_BUNDLE, 'Contents', 'MacOS', 'Antigravity') : path.join(APP_BUNDLE, 'Antigravity.exe'))
  : '';

const LS_BIN = APP_BUNDLE && IS_MAC
  ? path.join(APP_BUNDLE, 'Contents', 'Resources', 'bin', 'language_server')
  : '';

/* Windows 原版补丁产物（保留兼容，mac 下不用） */
const BACKUP_DIR = path.join(ROOT_DIR, 'backup');
const BACKUP_DLL = path.join(BACKUP_DIR, 'version.dll');
const BACKUP_JSON = path.join(BACKUP_DIR, 'config.json');

/* macOS 补丁产物 */
const DYLD_SCRIPT = path.join(ROOT_DIR, 'scripts', 'easyag-dyld.sh');
const DYLD_DYLIB = path.join(ROOT_DIR, 'native', 'libeasyag_proxy.dylib');
const DYLD_CONF = path.join(SUPPORT_DIR, 'easyag-proxy.json');
const DYLD_LOG = path.join(SUPPORT_DIR, 'language_server.easyag.log');
const DYLD_STATE = path.join(SUPPORT_DIR, 'state.json');
const WRAPPER_MARK = '# EASYG_WRAPPER_V1';

const DICT_DIR = path.join(ROOT_DIR, 'dicts');
const RULES_FILE = path.join(ROOT_DIR, 'danger-rules.json');
const BACKUP_RULES = path.join(BACKUP_DIR, 'danger-rules.json');

/* ===================================================================== */
/* 状态                                                                   */
/* ===================================================================== */
let state = {
  platform: process.platform,
  appPath: APP_BUNDLE || '',
  appFound: !!APP_BUNDLE,
  appVersion: '',
  /* env = 零侵入（Chromium --proxy-server + 环境变量）
     dyld = 深度注入（等价 Windows version.dll）
     off  = 不做代理 */
  proxyMode: IS_MAC ? 'env' : 'win-dll',
  proxyEnabled: true,
  port: 7890,
  proxyReachable: false,
  autoAccept: true,
  blockDangerous: true,
  preferOption: 4,
  enableI18n: true,
  dictEntries: 0,
  patchOk: false,
  patchDetail: '',
  dyldInstalled: false,
  dyldDylibBuilt: false,
  clientRunning: false,
  dangerRulesTotal: 0,
  dangerRulesOn: 0,
  approveCount: 0,
  blockCount: 0,
  cdpTargets: 0,
  cdpSockets: 0,
  injectCount: 0,
  lastInjectAt: 0,
  cdpError: '',
  cdpFailStreak: 0,
  cdpLoopRunning: false,
  busy: ''
};

/* ===================================================================== */
/* 单实例锁                                                               */
/* ===================================================================== */
function readLockPid() {
  try {
    const s = fs.readFileSync(LOCK_FILE, 'utf-8').trim();
    const n = parseInt(s, 10);
    return Number.isFinite(n) ? n : 0;
  } catch (e) { return 0; }
}

function isPidAlive(pid) {
  if (!pid || pid <= 0) return false;
  try { return !!process.kill(pid, 0); }
  catch (e) { return e && e.code === 'EPERM'; }
}

function releaseLock() {
  try {
    const pid = readLockPid();
    if (!pid || pid === process.pid) fs.unlinkSync(LOCK_FILE);
  } catch (e) {}
}

function alreadyRunning() {
  const pid = readLockPid();
  return isPidAlive(pid) && pid !== process.pid;
}

/* ===================================================================== */
/* 平台层：打开 GUI 窗口                                                  */
/* ===================================================================== */
const MAC_BROWSERS = [
  ['/Applications/Google Chrome.app', 'Google Chrome'],
  ['/Applications/Microsoft Edge.app', 'Microsoft Edge'],
  ['/Applications/Brave Browser.app', 'Brave Browser'],
  ['/Applications/Chromium.app', 'Chromium'],
  ['/Applications/Arc.app', 'Arc'],
  ['/Applications/Vivaldi.app', 'Vivaldi']
];

function openGuiWindow() {
  const url = `http://127.0.0.1:${GUI_PORT}/?t=${Date.now()}`;
  if (IS_MAC) {
    for (const [bundle, exeName] of MAC_BROWSERS) {
      if (!fs.existsSync(bundle)) continue;
      try {
        fs.mkdirSync(GUI_PROFILE_DIR, { recursive: true });
        const exe = path.join(bundle, 'Contents', 'MacOS', exeName);
        if (!fs.existsSync(exe)) continue;
        const child = spawn(exe, [
          `--app=${url}`,
          '--window-size=470,760',
          '--no-first-run',
          '--no-default-browser-check',
          '--disable-features=Translate,ChromeWhatsNewUI',
          `--user-data-dir=${GUI_PROFILE_DIR}`
        ], { detached: true, stdio: 'ignore' });
        child.unref();
        return true;
      } catch (e) {}
    }
    try {
      execFile('open', [url], () => {});
      return true;
    } catch (e) { return false; }
  }
  if (IS_WIN) {
    try { exec(`start msedge --app=${url} --force-dark-mode`); return true; }
    catch (e) { return false; }
  }
  try { execFile('xdg-open', [url], () => {}); return true; }
  catch (e) { return false; }
}

/* ===================================================================== */
/* 平台层：用默认程序打开文件                                             */
/* ===================================================================== */
function openWithDefaultApp(file) {
  if (IS_MAC) return spawn('open', [file], { detached: true, stdio: 'ignore' }).unref();
  if (IS_WIN) return spawn('explorer.exe', [file], { detached: true, stdio: 'ignore' }).unref();
  return spawn('xdg-open', [file], { detached: true, stdio: 'ignore' }).unref();
}

function revealInFileManager(file) {
  if (IS_MAC) return spawn('open', ['-R', file], { detached: true, stdio: 'ignore' }).unref();
  return openWithDefaultApp(path.dirname(file));
}

/* ===================================================================== */
/* GUI 存活：关窗后应真正退出后台                                          */
/* ===================================================================== */
let guiSeen = false;
let lastGuiAt = 0;
let quitting = false;

function touchGui() { guiSeen = true; lastGuiAt = Date.now(); }

function quitApp(reason) {
  if (quitting) return;
  quitting = true;
  state.clientRunning = false;
  for (const [, entry] of cdpSockets) {
    try { entry.ws.close(); } catch (e) {}
  }
  cdpSockets.clear();
  releaseLock();
  setTimeout(() => process.exit(0), 80);
}

/* ===================================================================== */
/* 高危规则                                                               */
/* ===================================================================== */
const DEFAULT_DANGER_RULES = [
  { id: 'rm-rf', name: '递归强制删除', pattern: '\\brm\\s+(-[a-zA-Z]*r[a-zA-Z]*f|--force)', flags: 'i', enabled: true },
  { id: 'windows-del', name: 'Windows 强制删除', pattern: '\\b(del|rd|rmdir)\\s+.*\\/[sqf]', flags: 'i', enabled: true },
  { id: 'disk-wipe', name: '磁盘破坏', pattern: '\\b(format|diskpart|mkfs|wipefs|shred|dd\\s+if=)\\b', flags: 'i', enabled: true },
  { id: 'sql-drop', name: '数据库删除', pattern: '\\bdrop\\s+(database|table)\\b', flags: 'i', enabled: true },
  { id: 'git-force-push', name: 'Git 强制推送', pattern: '\\bgit\\s+push\\s+.*(-f|--force)\\b', flags: 'i', enabled: true },
  { id: 'shutdown', name: '关机/停止计算机', pattern: '\\b(shutdown|halt|reboot)\\b', flags: 'i', enabled: true },
  { id: 'chmod-777-root', name: '危险权限变更', pattern: '\\bchmod\\s+-R\\s+777\\s+\\/', flags: 'i', enabled: true },
  { id: 'curl-pipe-sh', name: '管道执行远程脚本', pattern: '\\b(curl|wget)\\b[^|]*\\|\\s*(ba)?sh\\b', flags: 'i', enabled: true }
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

/* ===================================================================== */
/* 汉化词典                                                               */
/* ===================================================================== */
let translationDict = {};
function loadDictionaries() {
  translationDict = {};
  ['ui_v2.json', 'common.json'].forEach(f => {
    const fullPath = path.join(DICT_DIR, f);
    if (fs.existsSync(fullPath)) {
      try { Object.assign(translationDict, JSON.parse(fs.readFileSync(fullPath, 'utf-8'))); }
      catch (e) {}
    }
  });
  state.dictEntries = Object.keys(translationDict).length;
}

/* ===================================================================== */
/* SSE 日志                                                               */
/* ===================================================================== */
let sseClients = [];

function logToGUI(category, message, cls = '') {
  const payload = JSON.stringify({ category, message, cls });
  const dead = [];
  sseClients.forEach(res => {
    try { res.write(`data: ${payload}\n\n`); }
    catch (e) { dead.push(res); }
  });
  if (dead.length) sseClients = sseClients.filter(c => dead.indexOf(c) < 0);
}

function pushCounters() {
  const payload = JSON.stringify({
    counters: true,
    approveCount: state.approveCount,
    blockCount: state.blockCount
  });
  sseClients.forEach(res => { try { res.write(`data: ${payload}\n\n`); } catch (e) {} });
}

/* ===================================================================== */
/* 平台层：代理补丁自愈                                                    */
/* ===================================================================== */
function isWrapperInstalled() {
  if (!LS_BIN || !fs.existsSync(LS_BIN)) return false;
  try {
    const head = fs.readFileSync(LS_BIN, 'utf-8').slice(0, 400);
    return head.indexOf(WRAPPER_MARK) >= 0;
  } catch (e) { return false; }
}

/* ===================================================================== */
/* 平台层：构造干净的子进程环境                                            */
/*                                                                       */
/* 坑：Electron 主二进制一旦看到 ELECTRON_RUN_AS_NODE=1 就退化成纯 Node，  */
/*     表现为 `bad option: --remote-debugging-port=9333` 然后秒退。        */
/*     NODE_OPTIONS 在打包应用里也会刷一堆 ERROR。两者都必须清掉。         */
/* ===================================================================== */
const ELECTRON_HOSTILE_ENV = [
  'ELECTRON_RUN_AS_NODE',
  'NODE_OPTIONS',
  'NODE_REPL_EXTERNAL_MODULE',
  'ELECTRON_NO_ATTACH_CONSOLE',
  'ELECTRON_ENABLE_LOGGING',
  'ELECTRON_ENABLE_STACK_DUMPING'
];

function buildLaunchEnv(extra) {
  const env = Object.assign({}, process.env);
  for (const k of ELECTRON_HOSTILE_ENV) delete env[k];
  if (extra) Object.assign(env, extra);
  return env;
}

function readAppVersion() {
  if (!APP_BUNDLE) return '';
  if (IS_MAC) {
    try {
      const info = fs.readFileSync(path.join(APP_BUNDLE, 'Contents', 'Info.plist'));
      const m = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(info.toString('utf-8'));
      return m ? m[1] : '';
    } catch (e) { return ''; }
  }
  return '';
}

function probeProxy(cb) {
  const sock = net.connect({ host: '127.0.0.1', port: state.port });
  let done = false;
  const finish = (okFlag) => {
    if (done) return;
    done = true;
    try { sock.destroy(); } catch (e) {}
    cb(okFlag);
  };
  sock.setTimeout(800);
  sock.on('connect', () => finish(true));
  sock.on('timeout', () => finish(false));
  sock.on('error', () => finish(false));
}

function runDyldScript(args, cb) {
  if (!fs.existsSync(DYLD_SCRIPT)) return cb(new Error('缺少 scripts/easyag-dyld.sh'));
  execFile('/bin/sh', [DYLD_SCRIPT].concat(args), { timeout: 180000 }, (err, stdout, stderr) => {
    cb(err, String(stdout || ''), String(stderr || ''));
  });
}

function readDyldState() {
  try { return JSON.parse(fs.readFileSync(DYLD_STATE, 'utf-8')); }
  catch (e) { return null; }
}

/**
 * 自愈：Windows 版检查 version.dll + config.json 是否被客户端更新抹掉；
 * macOS 版检查注入壳是否被更新覆盖、dylib 是否还在、配置端口是否同步。
 */
function ensureProxyWatchdog() {
  state.appVersion = readAppVersion();
  state.dyldDylibBuilt = fs.existsSync(DYLD_DYLIB);

  if (!IS_MAC) {
    /* Windows 原版逻辑保留 */
    if (!APP_BUNDLE) { state.patchOk = false; return false; }
    const TARGET_DLL = path.join(APP_BUNDLE, 'version.dll');
    const TARGET_JSON = path.join(APP_BUNDLE, 'config.json');
    let restored = false;
    if (!fs.existsSync(TARGET_DLL) && fs.existsSync(BACKUP_DLL)) { fs.copyFileSync(BACKUP_DLL, TARGET_DLL); restored = true; }
    if (!fs.existsSync(TARGET_JSON) && fs.existsSync(BACKUP_JSON)) { fs.copyFileSync(BACKUP_JSON, TARGET_JSON); restored = true; }
    state.patchOk = fs.existsSync(TARGET_DLL) && fs.existsSync(TARGET_JSON);
    return restored;
  }

  if (state.proxyMode === 'off') {
    state.patchOk = true;
    state.patchDetail = '代理已关闭';
    return false;
  }

  if (state.proxyMode === 'dyld') {
    const installed = isWrapperInstalled();
    state.dyldInstalled = installed;
    const st = readDyldState();
    const versionChanged = !!(st && st.appVersion && state.appVersion && st.appVersion !== state.appVersion);
    state.patchOk = installed && state.dyldDylibBuilt;
    if (!installed) {
      state.patchDetail = '注入壳缺失，点击「安装注入」恢复';
    } else if (versionChanged) {
      state.patchDetail = `客户端已从 ${st.appVersion} 更新到 ${state.appVersion}，建议重新安装注入`;
    } else if (!state.dyldDylibBuilt) {
      state.patchDetail = 'dylib 未编译';
    } else {
      state.patchDetail = `已注入 language_server · ${state.appVersion}`;
    }
    return false;
  }

  /* env 模式：没有落盘补丁，只要代理端口活着就算就绪 */
  state.dyldInstalled = isWrapperInstalled();
  state.patchOk = state.proxyReachable;
  state.patchDetail = state.proxyReachable
    ? `免 TUN 环境变量模式 · 代理 127.0.0.1:${state.port} 可达`
    : `代理 127.0.0.1:${state.port} 不可达`;
  return false;
}

function syncProxyPort(newPort) {
  state.port = newPort;
  if (IS_WIN) {
    const TARGET_JSON = APP_BUNDLE ? path.join(APP_BUNDLE, 'config.json') : '';
    [BACKUP_JSON, TARGET_JSON].forEach(file => {
      if (file && fs.existsSync(file)) {
        try {
          const cfg = JSON.parse(fs.readFileSync(file, 'utf-8'));
          if (!cfg.proxy) cfg.proxy = {};
          cfg.proxy.port = newPort;
          fs.writeFileSync(file, JSON.stringify(cfg, null, 2), 'utf-8');
        } catch (e) {}
      }
    });
  } else if (IS_MAC && state.proxyMode === 'dyld') {
    runDyldScript(['refresh', String(newPort)], () => {});
  }
  logToGUI('PROXY', `SOCKS5 端口已同步更新为: ${newPort}`, 'tag-proxy');
}

/* ===================================================================== */
/* CDP 注入脚本（与原版一致，平台无关）                                     */
/* ===================================================================== */
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
        t === 'submit' || t.startsWith('submit') ||
        t === '提交' || t.includes('提交') ||
        t === 'confirm' || t.startsWith('confirm') ||
        t === '确认' || t.startsWith('确认') ||
        t === 'allow' || t === '允许' ||
        t.includes('submit ↵') || t.includes('提交 ↵') || t.includes('submit enter')
      );
    }

    function findSubmitBtn(root) {
      if (!root || !root.querySelector) return null;
      const byTest = root.querySelector(
        'button[data-testid="interaction-continue-button"], [data-testid="interaction-continue-button"]'
      );
      if (byTest && !byTest.disabled && !byTest.hasAttribute('data-ea-ok')) return byTest;
      const btns = Array.from(root.querySelectorAll('button, [role="button"], div[role="button"], input[type="submit"]'));
      return btns.find(b => {
        if (!b || b.disabled || b.hasAttribute('data-ea-ok')) return false;
        return isSubmitLabel(b.innerText || b.value || b.getAttribute('aria-label'));
      }) || null;
    }

    function cardForSubmit(btn) {
      return (
        btn.closest('[data-testid="run-command-step"]') ||
        btn.closest('div.relative.flex.flex-col') ||
        btn.closest('div[class*="card"]') ||
        btn.closest('div[class*="container"]') ||
        btn.parentElement?.parentElement?.parentElement?.parentElement ||
        btn.parentElement
      );
    }

    function oneLine(s, n) {
      s = String(s || '').replace(/\\s+/g, ' ').trim();
      if (n && s.length > n) s = s.slice(0, Math.max(1, n - 1)) + '…';
      return s;
    }

    function clip(s, n) {
      s = String(s || '').replace(/\\s+/g, ' ').trim();
      if (s.length <= n) return s;
      return s.slice(0, n - 1) + '…';
    }

    function extractCommandText(card) {
      if (!card) return '';
      const code = card.querySelector('pre, code, [data-testid="run-command-step"] pre');
      if (code && (code.innerText || code.textContent || '').trim()) {
        return (code.innerText || code.textContent || '').trim();
      }
      const step = card.querySelector('[data-testid="run-command-step"]');
      if (step) return (step.innerText || '').trim();
      return '';
    }

    function extractLogSummary(card, fallback) {
      const full = extractCommandText(card);
      if (full) {
        const lines = full.split('\\n').map(s => s.trim()).filter(Boolean);
        const q = lines.find(l => /[?？]$/.test(l) && l.length < 120);
        const cmdLine = lines.find(l => !/[?？]$/.test(l) && l.length > 2);
        return oneLine(q || cmdLine || lines[0], 80);
      }
      return oneLine(fallback || '', 80);
    }

    function classifyOption(tx) {
      const t = norm(tx);
      if (!t || t.length > 200) return 0;
      const isAlways = /always allow|始终允许|总是允许|一直允许/.test(t);
      const isThisTime = /\\bthis time\\b|仅允许本次|仅这一次|只允许本次|仅本次/.test(t);
      const isSession = /\\bin this conversation\\b|\\bthis session\\b|\\bthis conversation\\b|对话中|本次会话|本次对话/.test(t);
      const isProject = /\\bin (this|every) project\\b|\\bthis project\\b|项目中|本项目|所有项目/.test(t);
      const num = t.match(/^([1-4])[\\s\\.\\:：\\-]/);
      if (num) return Number(num[1]);
      if (isThisTime && !isAlways) return 1;
      if (isAlways && isSession && !isProject) return 2;
      if (isAlways && isProject) return 3;
      if (isAlways && !isSession && !isProject && !isThisTime) return 4;
      if (t === '1' || t === '2' || t === '3' || t === '4') return Number(t);
      return 0;
    }

    function collectOptionCands(card) {
      const nodes = Array.from(card.querySelectorAll(
        'label, [role="radio"], [role="option"], [data-testid*="option"], [data-testid*="radio"], button, div, span, li'
      ));
      const cands = [];
      const seen = new Set();
      for (const el of nodes) {
        if (!el || seen.has(el)) continue;
        const raw = (el.innerText || el.textContent || '').trim();
        if (!raw || raw.length > 160) continue;
        if (raw.includes('\\n') && raw.split('\\n').filter(Boolean).length > 2) continue;
        const kids = el.children ? Array.from(el.children) : [];
        if (kids.length) {
          const kidTexts = kids.map(k => (k.innerText || '').trim()).join(' ');
          if (kidTexts && norm(kidTexts) === norm(raw) && raw.length > 20) continue;
        }
        const cls = classifyOption(raw);
        if (!cls) continue;
        const st = el.getAttribute && el.getAttribute('data-state');
        const checked = (
          el.checked === true ||
          el.getAttribute('aria-checked') === 'true' ||
          st === 'checked' || st === 'on' ||
          (el.classList && el.classList.contains('checked'))
        );
        const score =
          (el.getAttribute && el.getAttribute('role') === 'radio' ? 40 : 0) +
          (el.tagName === 'LABEL' ? 30 : 0) +
          (el.getAttribute && /option|radio|choice/i.test(el.getAttribute('data-testid') || '') ? 35 : 0) +
          (checked ? 10 : 0) -
          Math.min(raw.length, 80) * 0.1;
        cands.push({ el, cls, score, checked, text: clip(raw, 80) });
        seen.add(el);
      }
      return cands;
    }

    function matchOptionEl(card, optIdx) {
      const idx = Number(optIdx) || 4;
      const cands = collectOptionCands(card);
      const exact = cands.filter(c => c.cls === idx);
      if (exact.length) {
        exact.sort((a, b) => b.score - a.score);
        return exact[0];
      }
      if (idx === 1) {
        const t1 = cands.filter(c => c.cls === 1);
        if (t1.length) return t1[0];
      }
      return null;
    }

    function tryApprove(btn, kind) {
      if (!btn || btn.disabled || btn.hasAttribute('data-ea-ok')) return false;
      const card = cardForSubmit(btn);
      if (window.__ea_config.blockDangerous) {
        const cmd = extractCommandText(card);
        if (cmd) {
          const hit = DANGEROUS_PATTERNS.find(r => r.re.test(cmd));
          if (hit) {
            btn.setAttribute('data-ea-ok', 'blocked');
            console.warn('[EA_ALERT] 拦截高危指令[' + hit.id + ']: ' + cmd.slice(0, 80));
            return true;
          }
        }
      }
      const optIdx = (window.__ea_config && window.__ea_config.preferOption) || 4;
      let optText = '';
      let picked = null;
      if (card) {
        const cands = collectOptionCands(card);
        if (cands.length) {
          const brief = cands.map(c => '#' + c.cls + (c.checked ? '*' : '') + oneLine(c.text, 36)).join(' | ');
          console.log('[EA_OPT] prefer=' + optIdx + ' · ' + oneLine(brief, 180));
        }
        picked = matchOptionEl(card, optIdx);
        if (picked && picked.el) {
          realClick(picked.el);
          optText = oneLine(picked.text, 40);
          const st = picked.el.getAttribute && picked.el.getAttribute('data-state');
          const stillOff = picked.el.checked === false ||
            picked.el.getAttribute('aria-checked') === 'false' || st === 'unchecked';
          if (stillOff) realClick(picked.el);
        } else if (cands.length) {
          console.warn('[EA_OPT] 未找到选项[' + optIdx + ']，暂不点击提交');
          return false;
        }
      }
      btn.setAttribute('data-ea-ok', 'true');
      realClick(btn);
      const cmd = extractLogSummary(card, kind || (btn.innerText || ''));
      const optLabel = picked ? '选项[' + picked.cls + '] ' + optText : '无选项组';
      console.log('[EA_AA] 放行 · ' + optLabel + ' · ' + cmd);
      return true;
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

        const interactSubmit = doc.querySelector('button[data-testid="interaction-continue-button"]');
        if (interactSubmit && tryApprove(interactSubmit, '交互卡提交')) return;

        const pageText = norm(doc.body ? doc.body.innerText : '');
        const permHit = /allow reading|yes, allow|允许访问|allow access|权限请求|请求权限|访问文件/.test(pageText)
          || (/(^|\\s)permission(\\s|$)/i.test(pageText) && /allow|允许|yes/i.test(pageText));
        if (permHit) {
          const cards = Array.from(doc.querySelectorAll('div, section, [role="dialog"], [role="alertdialog"]'));
          for (const card of cards) {
            const t = norm(card.innerText);
            if (!t || t.length > 2500) continue;
            if (!/allow reading|yes, allow|允许访问|allow access|permission|权限|访问文件/.test(t)) continue;
            const submitBtn = findSubmitBtn(card);
            if (submitBtn && tryApprove(submitBtn, '权限卡')) return;
          }
        }

        const kws = ['run', 'accept', 'continue', 'always allow', 'allow', '运行', '接受', '继续', '始终允许', '允许', '确认', '提交'];
        for (const btn of Array.from(doc.querySelectorAll('button, [role="button"]'))) {
          const txt = norm(btn.innerText || btn.getAttribute('aria-label'));
          if (!txt || txt.length > 24) continue;
          if (kws.some(k => txt === k || txt.startsWith(k))) {
            if (tryApprove(btn, txt)) return;
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

/* ===================================================================== */
/* CDP                                                                    */
/* ===================================================================== */
function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: 4000 }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
  });
}

const cdpSockets = new Map();
let cdpCmdId = 1;

function cdpSend(ws, method, params = {}) {
  const id = cdpCmdId++;
  try {
    ws.send(JSON.stringify({ id, method, params }));
    return true;
  } catch (e) {
    state.cdpError = `send ${method}: ${e.message || e}`;
    return false;
  }
}

function injectInto(ws, reason = '') {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  const ok = cdpSend(ws, 'Runtime.evaluate', {
    expression: generateMasterInjectScript(),
    returnByValue: false,
    awaitPromise: false
  });
  if (ok) {
    state.injectCount += 1;
    state.lastInjectAt = Date.now();
    state.cdpError = '';
  }
  return ok;
}

let lastStatusKey = '';
function pushClientStatus() {
  const alive = state.clientRunning && state.cdpSockets > 0;
  const status = !state.clientRunning
    ? '客户端未运行'
    : alive
      ? `运行中 · 引擎注入 ${state.cdpSockets}`
      : '运行中 · 等待 CDP';
  const payload = {
    status,
    clientRunning: state.clientRunning,
    cdpSockets: state.cdpSockets,
    cdpTargets: state.cdpTargets,
    injectCount: state.injectCount,
    lastInjectAt: state.lastInjectAt,
    cdpError: state.cdpError
  };
  const key = [status, state.clientRunning, state.cdpSockets, state.cdpTargets, state.cdpError].join('|');
  if (key === lastStatusKey) return;
  lastStatusKey = key;
  sseClients.forEach(res => { try { res.write(`data: ${JSON.stringify(payload)}\n\n`); } catch (e) {} });
}

async function startCDPLoop() {
  if (state.cdpLoopRunning) return;
  state.cdpLoopRunning = true;
  state.cdpFailStreak = 0;
  while (state.clientRunning) {
    try {
      const targets = await httpGetJson(`http://127.0.0.1:${CDP_PORT}/json/list`);
      const valid = (targets || []).filter(t =>
        t && t.webSocketDebuggerUrl &&
        !String(t.url || '').startsWith('devtools://') &&
        !String(t.url || '').startsWith('data:text/html')
      );

      state.cdpTargets = valid.length;
      if (valid.length > 0) state.cdpFailStreak = 0;
      const aliveIds = new Set(valid.map(t => t.webSocketDebuggerUrl));

      for (const [key, entry] of cdpSockets) {
        if (!aliveIds.has(key)) {
          try { entry.ws.close(); } catch (e) {}
          cdpSockets.delete(key);
        }
      }

      for (const target of valid) {
        const key = target.webSocketDebuggerUrl;

        if (!cdpSockets.has(key)) {
          const ws = new WebSocket(key);
          const entry = { ws, title: target.title || '', url: target.url || '' };
          cdpSockets.set(key, entry);

          ws.on('open', () => {
            cdpSend(ws, 'Runtime.enable');
            cdpSend(ws, 'Page.enable');
            injectInto(ws, 'open');
            logToGUI('CDP', `已连接目标并注入: ${String(entry.title || entry.url).slice(0, 60)}`, 'tag-i18n');
            pushClientStatus();
          });

          ws.on('message', (data) => {
            try {
              const msg = JSON.parse(data.toString());
              if (
                msg.method === 'Runtime.executionContextCreated' ||
                msg.method === 'Page.loadEventFired' ||
                msg.method === 'Page.frameNavigated'
              ) {
                injectInto(ws, msg.method);
              }
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

          ws.on('error', (err) => {
            state.cdpError = `ws: ${err.message || err}`;
            logToGUI('CDP', `WebSocket 错误: ${err.message || err}`, 'tag-warn');
            cdpSockets.delete(key);
            try { ws.close(); } catch (e) {}
            pushClientStatus();
          });

          ws.on('close', () => {
            cdpSockets.delete(key);
            pushClientStatus();
          });
        } else {
          const entry = cdpSockets.get(key);
          if (entry.ws.readyState === WebSocket.OPEN) {
            injectInto(entry.ws, 'tick');
          } else {
            try { entry.ws.close(); } catch (e) {}
            cdpSockets.delete(key);
          }
        }
      }

      state.cdpSockets = cdpSockets.size;
      if (valid.length === 0) state.cdpError = 'CDP 无可用页面目标';
    } catch (e) {
      state.cdpError = String(e.message || e);
      state.cdpSockets = cdpSockets.size;
      state.cdpFailStreak += 1;
      if (state.cdpFailStreak >= 5) {
        state.clientRunning = false;
        state.cdpTargets = 0;
        state.cdpSockets = 0;
        for (const [, entry] of cdpSockets) {
          try { entry.ws.close(); } catch (e) {}
        }
        cdpSockets.clear();
        logToGUI('SYSTEM', 'CDP 失联，已标记客户端停止', 'tag-warn');
        pushClientStatus();
        break;
      }
    }
    pushClientStatus();
    await new Promise(r => setTimeout(r, 2000));
  }
  state.cdpLoopRunning = false;
  state.clientRunning = false;
  state.cdpSockets = 0;
  pushClientStatus();
}

/* ===================================================================== */
/* HTTP 服务                                                              */
/* ===================================================================== */
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

const HTML_FILE = path.join(ROOT_DIR, 'index.html');

function jsonRes(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function readBody(req, cb) {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => cb(body));
}

const server = http.createServer((req, res) => {
  const urlPath = (req.url || '').split('?')[0];

  if (urlPath === '/') {
    touchGui();
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'Pragma': 'no-cache'
    });
    return res.end(fs.readFileSync(HTML_FILE));
  }

  if (urlPath.startsWith('/assets/')) {
    const rel = decodeURIComponent(urlPath).replace(/^\/assets\//, '');
    const safe = path.normalize(rel).replace(/^(\.\.[\/\\])+/, '');
    const file = path.join(ROOT_DIR, 'assets', safe);
    if (!file.startsWith(path.join(ROOT_DIR, 'assets')) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404); return res.end('not found');
    }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    return res.end(fs.readFileSync(file));
  }

  if (urlPath === '/api/danger-rules' && req.method === 'GET') {
    return jsonRes(res, 200, {
      path: RULES_FILE,
      enabled: dangerRules.enabled !== false,
      rules: dangerRules.rules,
      active: state.dangerRulesOn,
      total: state.dangerRulesTotal
    });
  }

  if (urlPath === '/api/danger-rules/reload' && req.method === 'POST') {
    loadDangerRules();
    logToGUI('SECURITY', `高危规则已重载: ${state.dangerRulesOn}/${state.dangerRulesTotal} 条生效`, 'tag-proxy');
    return jsonRes(res, 200, { ok: true, active: state.dangerRulesOn, total: state.dangerRulesTotal });
  }

  if (urlPath === '/api/danger-rules/open' && req.method === 'POST') {
    try {
      if (!fs.existsSync(RULES_FILE) && fs.existsSync(BACKUP_RULES)) {
        fs.copyFileSync(BACKUP_RULES, RULES_FILE);
      }
      if (!fs.existsSync(RULES_FILE)) return jsonRes(res, 404, { ok: false, error: 'rules file missing' });
      openWithDefaultApp(RULES_FILE);
      return jsonRes(res, 200, { ok: true, path: RULES_FILE });
    } catch (e) {
      return jsonRes(res, 500, { ok: false, error: String(e.message || e) });
    }
  }

  if (urlPath === '/api/reveal' && req.method === 'POST') {
    readBody(req, (body) => {
      try {
        const d = JSON.parse(body || '{}');
        const target = d.path || SUPPORT_DIR;
        if (fs.existsSync(target)) revealInFileManager(target);
        jsonRes(res, 200, { ok: true, path: target });
      } catch (e) {
        jsonRes(res, 500, { ok: false, error: String(e.message || e) });
      }
    });
    return;
  }

  if (urlPath === '/api/status') {
    touchGui();
    probeProxy((okFlag) => {
      state.proxyReachable = okFlag;
      ensureProxyWatchdog();
      jsonRes(res, 200, state);
    });
    return;
  }

  if (urlPath === '/api/quit' && req.method === 'POST') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true }));
    quitApp('收到退出请求');
    return;
  }

  if (urlPath === '/api/events') {
    touchGui();
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
    sseClients.push(res);
    req.on('close', () => { sseClients = sseClients.filter(c => c !== res); });
    return;
  }

  if (urlPath === '/api/config' && req.method === 'POST') {
    readBody(req, (body) => {
      try {
        const data = JSON.parse(body);
        if (data.port) {
          const portNum = parseInt(data.port, 10);
          if (portNum >= 1 && portNum <= 65535) syncProxyPort(portNum);
          else logToGUI('PROXY', `非法端口输入 [${data.port}]，已忽略`, 'tag-warn');
        }
        if (typeof data.autoAccept === 'boolean') state.autoAccept = data.autoAccept;
        if (typeof data.blockDangerous === 'boolean') state.blockDangerous = data.blockDangerous;
        if (typeof data.enableI18n === 'boolean') state.enableI18n = data.enableI18n;
        if (data.preferOption) state.preferOption = data.preferOption;
        res.end('ok');
      } catch (e) {
        res.writeHead(400); res.end('invalid json');
      }
    });
    return;
  }

  if (urlPath === '/api/proxy-mode' && req.method === 'POST') {
    readBody(req, (body) => {
      let mode = '';
      try { mode = (JSON.parse(body || '{}').mode || '').trim(); } catch (e) {}
      const allowed = IS_MAC ? ['env', 'dyld', 'off'] : ['win-dll', 'off'];
      if (allowed.indexOf(mode) < 0) {
        return jsonRes(res, 400, { ok: false, error: 'invalid mode', allowed });
      }
      if (mode === 'dyld' && state.clientRunning) {
        return jsonRes(res, 409, { ok: false, error: '请先关闭 Antigravity 再切换代理模式' });
      }
      state.proxyMode = mode;
      state.proxyEnabled = mode !== 'off';
      const label = { env: '免 TUN 环境变量模式', dyld: '深度注入模式 (DYLD)', off: '已关闭', 'win-dll': 'version.dll 补丁' }[mode];
      logToGUI('PROXY', `代理模式已切换为: ${label}`, 'tag-proxy');
      ensureProxyWatchdog();
      jsonRes(res, 200, { ok: true, mode });
    });
    return;
  }

  if (urlPath === '/api/dyld/apply' && req.method === 'POST') {
    if (!IS_MAC) return jsonRes(res, 400, { ok: false, error: '仅 macOS 支持' });
    if (state.clientRunning) return jsonRes(res, 409, { ok: false, error: '请先关闭 Antigravity' });
    state.busy = '安装注入';
    logToGUI('PROXY', '开始安装深度注入（重签 language_server）…', 'tag-proxy');
    runDyldScript(['apply', String(state.port)], (err, out, errOut) => {
      state.busy = '';
      const text = (out || '') + (errOut ? '\n' + errOut : '');
      text.split('\n').filter(Boolean).forEach(line => logToGUI('PROXY', line, 'tag-proxy'));
      state.proxyMode = 'dyld';
      state.proxyEnabled = true;
      ensureProxyWatchdog();
      jsonRes(res, err ? 500 : 200, { ok: !err, output: text });
    });
    return;
  }

  if (urlPath === '/api/dyld/revert' && req.method === 'POST') {
    if (!IS_MAC) return jsonRes(res, 400, { ok: false, error: '仅 macOS 支持' });
    if (state.clientRunning) return jsonRes(res, 409, { ok: false, error: '请先关闭 Antigravity' });
    state.busy = '还原';
    runDyldScript(['revert'], (err, out, errOut) => {
      state.busy = '';
      const text = (out || '') + (errOut ? '\n' + errOut : '');
      text.split('\n').filter(Boolean).forEach(line => logToGUI('PROXY', line, 'tag-warn'));
      state.proxyMode = 'env';
      ensureProxyWatchdog();
      jsonRes(res, err ? 500 : 200, { ok: !err, output: text });
    });
    return;
  }

  if (urlPath === '/api/launch' && req.method === 'POST') {
    if (!APP_BUNDLE || !fs.existsSync(APP_EXE)) {
      logToGUI('SYSTEM', '未找到 Antigravity.app，请确认已安装', 'tag-alert');
      return jsonRes(res, 404, { ok: false, error: 'Antigravity not found' });
    }

    ensureProxyWatchdog();
    if (IS_MAC && state.proxyMode === 'dyld') {
      logToGUI('PROXY', state.dyldInstalled
        ? '深度注入壳已就位（language_server 走 DYLD 劫持）'
        : '⚠ 注入壳缺失，建议先点「安装注入」', state.dyldInstalled ? 'tag-proxy' : 'tag-warn');
    } else if (IS_MAC) {
      logToGUI('PROXY', state.proxyReachable
        ? `免 TUN 就绪 · SOCKS5 127.0.0.1:${state.port} 可达`
        : `⚠ SOCKS5 127.0.0.1:${state.port} 不可达，请检查本地代理`, state.proxyReachable ? 'tag-proxy' : 'tag-warn');
    }

    if (state.enableI18n) logToGUI('I18N', `已装载汉化引擎 (${state.dictEntries} 条词条)`, 'tag-i18n');

    if (state.clientRunning) {
      logToGUI('SYSTEM', '客户端已在运行，CDP 注入通道保持重试', 'tag-warn');
      pushClientStatus();
      return res.end('ok');
    }

    const args = [`--remote-debugging-port=${CDP_PORT}`];
    const extraEnv = {};

    if (state.proxyEnabled && state.proxyMode === 'env') {
      /* Chromium 网络栈：命令行开关最可靠 */
      args.push(`--proxy-server=socks5://127.0.0.1:${state.port}`);
      /* 子进程（language_server / node sidecar）：环境变量 */
      extraEnv.ALL_PROXY = `socks5://127.0.0.1:${state.port}`;
      extraEnv.HTTPS_PROXY = `socks5://127.0.0.1:${state.port}`;
      extraEnv.HTTP_PROXY = `socks5://127.0.0.1:${state.port}`;
      extraEnv.NO_PROXY = '127.0.0.1,localhost,::1';
      extraEnv.no_proxy = extraEnv.NO_PROXY;
    }
    /* dyld 模式下不再加 --proxy-server：dylib 已在 connect 层拦截，
       再加会让 Chromium 先连代理、dylib 又拦一次，形成自环 */

    /* 必须清掉 ELECTRON_RUN_AS_NODE / NODE_OPTIONS，否则 Antigravity 秒退 */
    const env = buildLaunchEnv(extraEnv);

    let child;
    try {
      child = spawn(APP_EXE, args, { detached: true, stdio: 'ignore', env });
    } catch (e) {
      logToGUI('SYSTEM', `启动失败: ${e.message || e}`, 'tag-alert');
      return jsonRes(res, 500, { ok: false, error: String(e.message || e) });
    }
    state.clientRunning = true;
    state.cdpError = '';
    state.cdpFailStreak = 0;
    logToGUI('SYSTEM', '✓ Antigravity 已启动，代理注入与 CDP 接管就绪', 'tag-proxy');
    pushClientStatus();

    startCDPLoop();
    const launchedAt = Date.now();
    child.on('exit', (code) => {
      state.clientRunning = false;
      state.cdpSockets = 0;
      for (const [, entry] of cdpSockets) {
        try { entry.ws.close(); } catch (e) {}
      }
      cdpSockets.clear();
      if (Date.now() - launchedAt < 4000) {
        logToGUI('SYSTEM',
          `⚠ Antigravity 启动后 ${Math.round((Date.now() - launchedAt) / 100) / 10}s 即退出 (code=${code})，` +
          `常见原因：环境变量 ELECTRON_RUN_AS_NODE=1 / NODE_OPTIONS 残留，或客户端自身报错`,
          'tag-alert');
      } else {
        logToGUI('SYSTEM', 'Antigravity 客户端已关闭', 'tag-warn');
      }
      pushClientStatus();
    });
    return res.end('ok');
  }

  jsonRes(res, 404, { ok: false, error: 'not found', url: req.url });
});

/* ===================================================================== */
/* 启动                                                                   */
/* ===================================================================== */
loadDictionaries();
loadDangerRules();

async function tryAttachExistingClient() {
  try {
    const targets = await httpGetJson(`http://127.0.0.1:${CDP_PORT}/json/list`);
    if (!Array.isArray(targets) || !targets.length) return false;
    state.clientRunning = true;
    logToGUI('SYSTEM', '检测到 Antigravity 已在运行，自动接管 CDP 注入', 'tag-proxy');
    startCDPLoop();
    return true;
  } catch (e) { return false; }
}

function writeCrashLog(msg) {
  try { fs.writeFileSync(path.join(ROOT_DIR, 'easyag-error.log'), String(msg), 'utf-8'); } catch (e) {}
}

server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    openGuiWindow();
    process.exit(0);
  }
  writeCrashLog(err && err.stack ? err.stack : String(err));
  process.exit(1);
});

process.on('uncaughtException', (err) => {
  writeCrashLog(err && err.stack ? err.stack : String(err));
});

process.on('exit', releaseLock);

/* 关窗后 8s 无任何 HTTP 活动 → 退出后台 */
setInterval(() => {
  if (quitting || !guiSeen) return;
  if (lastGuiAt && Date.now() - lastGuiAt >= 8000) quitApp('GUI 已关闭');
}, 2000);

server.listen(GUI_PORT, '127.0.0.1', () => {
  try { fs.writeFileSync(LOCK_FILE, String(process.pid), 'utf-8'); } catch (e) {}

  state.appVersion = readAppVersion();
  ensureProxyWatchdog();

  logToGUI('SECURITY', `高危规则已加载: ${state.dangerRulesOn}/${state.dangerRulesTotal} 条生效`, 'tag-proxy');
  logToGUI('SYSTEM',
    APP_BUNDLE ? `已定位 Antigravity: ${APP_BUNDLE} (v${state.appVersion || '?'})` : '⚠ 未找到 Antigravity.app',
    APP_BUNDLE ? 'tag-proxy' : 'tag-alert');

  openGuiWindow();
  setTimeout(() => { tryAttachExistingClient(); }, 500);
});
