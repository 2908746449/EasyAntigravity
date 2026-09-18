# EasyAntigravity · macOS 适配版

Windows 版 EasyAntigravity 的 macOS 移植。功能对齐：**免 TUN 代理 · 界面汉化 · 自动审批 · 高危拦截**。

原版面向 Windows，核心是丢一个 `version.dll` 到 Antigravity 安装目录劫持 winsock。macOS 上这条路不存在——本移植用 **DYLD 注入 + libsystem `connect()` 拦截**做等价替换，并针对 macOS 的代码签名限制做了完整处理。

---

## 与 Windows 版的对应关系

| 能力 | Windows 原版 | macOS 本版 |
|---|---|---|
| 免 TUN 代理落点 | `version.dll` 劫持 winsock `connect()` | `libeasyag_proxy.dylib` 劫持 libsystem `connect()` |
| 注入方式 | DLL 侧加载（同目录） | `DYLD_INSERT_LIBRARIES` + 重签名解锁 |
| 客户端定位 | `%LOCALAPPDATA%\Programs\antigravity` | `/Applications/Antigravity.app` |
| 客户端启动 | `Antigravity.exe` | `Contents/MacOS/Antigravity` |
| 面板窗口 | `msedge --app=` | Chrome / Edge / Brave / Chromium `--app=` |
| 打开规则文件 | `explorer.exe` | `open` |
| 补丁自愈 | 检测 `version.dll` 被更新抹除 | 检测注入壳被更新覆盖 + 版本变更告警 |
| 隐藏控制台 | 重启自身 + `windowsHide` | 不需要（`.app` 由 LaunchServices 启动，无终端） |
| 汉化 / 自动审批 / 高危拦截 | CDP 注入 | **完全一致**（同一份注入引擎） |

---

## 快速开始

```bash
cd macos
./install.sh
```

安装脚本会：定位 node → 装 `ws` → 编译 dylib → 生成 `~/Applications/EasyAntigravity.app`。

启动方式（任选）：

1. **访达 → 应用程序 → EasyAntigravity**（推荐，无终端窗口）
2. 双击 `macos/start.command`
3. `cd macos && npm start`

首次使用：面板里选 **「深度注入 · DYLD 劫持模式」** → 点 **「安装注入」** → 点 **「启动 Antigravity」**。

---

## 两种代理模式

面板「网络与免 TUN 链路」里切换。

### 零侵入 · 环境变量模式（默认）

不改动 Antigravity 任何文件。

- 主进程 / 渲染进程：`--proxy-server=socks5://127.0.0.1:<port>`
- 子进程（`language_server`、node sidecar）：`ALL_PROXY` / `HTTPS_PROXY` / `HTTP_PROXY`

**局限**：`language_server` 是 Go 写的，gRPC 默认不读代理环境变量。HTTP 部分能走代理，gRPC 部分可能直连。

### 深度注入 · DYLD 劫持模式

Windows `version.dll` 的严格等价物。在 `connect()` 这一层拦截，**不依赖上层用什么 HTTP/gRPC 库**，覆盖完整。

做的事：

1. 备份原始 `Contents/Resources/bin/language_server` → `language_server.easyag-real`
2. 给 `language_server.easyag-real` **重签名**，带上：
   - `com.apple.security.cs.allow-dyld-environment-variables`
   - `com.apple.security.cs.disable-library-validation`
3. 把 `language_server` 换成注入壳（设置 `DYLD_INSERT_LIBRARIES` 后 `exec` 真身）
4. 配置写到 `~/Library/Application Support/EasyAntigravity/easyag-proxy.json`

**为什么必须重签名**：Antigravity 全部二进制带 hardened runtime（`flags=0x10000`），dyld 会直接剥离 `DYLD_INSERT_LIBRARIES`。实测原版二进制注入无效，重签名后立即可用。

**为什么不注入主进程**：主进程也是 hardened runtime，同样被剥离；而且 Chromium 主进程的网络走自己的栈，用 `--proxy-server` 更干净。只有 `language_server` 需要注入。

**一键还原**：面板点「还原原版」，或 `sh macos/scripts/easyag-dyld.sh revert`。原始二进制完整留档在
`~/Library/Application Support/EasyAntigravity/backup/language_server.orig`。

---

## dylib 干了什么

`native/proxyhook.c`，约 600 行：

- **拦截 `connect()`**：目标非本地/私网 → 改连本地 SOCKS5，做完整 SOCKS5 握手（含域名远端解析）
- **拦截 `getaddrinfo()`**：记录 `IP → 域名` 映射，这样连到 fake-IP（`198.18.0.0/15`，TUN 常见）时也能把真实域名交给代理解析，避免 DNS 污染
- **阻断公网 UDP 80/443**：逼 Chromium 从 QUIC 回落 TCP（等价原版 `udp_mode: block`）
- **放行**：loopback / `10/8` / `172.16/12` / `192.168/16` / `169.254/16` / `fc00::/7` / `fe80::/10` / 代理自身
- **任何异常都回落真实系统调用**，绝不阻断宿主进程

### 三个 macOS 特有的坑（都已解决）

**1. `dlsym(RTLD_NEXT)` 取不到真身**

dyld 默认开启 dlsym interposing，静态插桩后 `dlsym(RTLD_NEXT, "connect")` 返回的是**我们自己的实现**，直接无限递归 SIGSEGV。

实测无效的方案：`dlsym(RTLD_NEXT)`、`dlopen`+`dlsym`、`RTLD_DEFAULT`、`DYLD_DISABLE_DLSYM_INTERPOSING=1`、`nlist` 扫 shared cache。

**有效方案**：`NSLookupSymbolInImage()` 在指定镜像内直接查符号，绕开 dlsym。

**2. `dyld_dynamic_interpose()` 装了不生效**

能拿到正确的真身地址，但对已解析的 chained fixup 调用点不重绑，拦截形同虚设。改用静态 `__DATA,__interpose` 段。

注意：段名必须落 `__DATA`。若落 `__DATA_CONST`，dyld 不认（链接器默认会放到 `__DATA_CONST`，需显式指定）。

**3. 主进程的 `DYLD_*` 传不下去**

hardened runtime 会把 `DYLD_INSERT_LIBRARIES` 从 `environ` 里抹掉，实测 Antigravity 主进程读到的是 `<STRIPPED>`。所以不能靠主进程把变量传给子进程，必须在 `language_server` 的启动路径上自己设——这就是注入壳存在的理由。

---

## 高危规则

`macos/danger-rules.json`。相比原版补了 macOS 常见项（`dd if=`、`chmod -R 777 /`、`curl | sh`）。

面板「打开规则」编辑，改完点「重载」立即生效。

---

## 自动审批选项

| 选项 | 含义 |
|---|---|
| 1 | 仅允许本次 |
| 2 | 对话中始终允许 |
| 3 | 项目中始终允许 |
| 4 | 全局始终允许（默认） |

中英文按钮文案都识别，汉化开启时同样可用。

---

## 验证状态

已在真实环境（macOS 26 / Apple Silicon / Antigravity 2.14.0）实测通过：

| 项 | 结果 |
|---|---|
| dylib 编译（arm64 + x86_64 universal） | ✅ |
| `connect()` 拦截生效 | ✅ 用假 SOCKS5 服务端抓到 `SOCKS5_CONNECT target=example.com:80 atyp=3` |
| 域名远端解析（fake-IP → 真实域名） | ✅ 上条同证 |
| 指向死端口时连接失败 | ✅ 证明流量确实过代理 |
| 重签名解锁 DYLD 注入 | ✅ 原版被剥离，重签后立即生效 |
| 注入壳参数透传 | ✅ `language_server --stamp` → `Built at CL: 981899915` |
| 真实 `language_server` 加载 dylib | ✅ 注入日志来自实际进程，配置路径正确 |
| 面板 API / SSE / 静态资源 | ✅ |
| `--remote-debugging-port=9333` 被接受 | ✅ `DevTools listening on ws://127.0.0.1:9333/` |
| Antigravity 正常 spawn `language_server` | ✅ 参数完整 |
| **GUI 完整联调（面板汉化 / 自动审批实跑）** | ⚠️ 未验证 |

**未验证原因**：验证时运行在受限执行沙箱里，Chromium 自身的 GPU 进程沙箱无法初始化（`sandbox initialization failed: Operation not permitted` → `FATAL: GPU process isn't usable. Goodbye.`），客户端无法进入 GUI。这是沙箱环境限制，不是本移植的问题。请在正常桌面会话中自行确认这一项。

---

## 排错

### 点「启动 Antigravity」后秒退

最常见原因：环境里有 `ELECTRON_RUN_AS_NODE=1`。

Electron 主二进制看到这个变量会退化成纯 Node，报 `bad option: --remote-debugging-port=9333` 然后退出。

面板已经会自动清掉 `ELECTRON_RUN_AS_NODE` 和 `NODE_OPTIONS`（见 `server.js` 的 `buildLaunchEnv()`）。如果你是从自己的终端启动面板且终端里有这些变量，面板也能正确处理。

### 注入后 Antigravity 打不开

先还原再排查：

```bash
sh macos/scripts/easyag-dyld.sh revert
```

### 客户端更新后代理失效

面板会检测版本变更并提示。点一次「安装注入」重新应用即可（客户端更新会覆盖注入壳）。

### 查看注入日志

```bash
tail -f ~/Library/Application\ Support/EasyAntigravity/language_server.easyag.log
```

### 完全卸载

```bash
sh macos/scripts/easyag-dyld.sh revert
rm -rf ~/Library/Application\ Support/EasyAntigravity
rm -rf ~/Applications/EasyAntigravity.app
```

---

## 目录结构

```
macos/
├── server.js                   # 主服务（HTTP + SSE + CDP 注入 + 平台层）
├── index.html                  # 控制面板
├── install.sh                  # 一键安装（生成 .app）
├── package.json
├── danger-rules.json           # 高危规则（可从 backup/ 自愈）
├── dicts/                      # 汉化词典
├── assets/                     # logo
├── backup/                     # 默认配置与规则留档
├── native/
│   ├── proxyhook.c             # SOCKS5 拦截 dylib 源码
│   ├── entitlements.plist      # 重签名所需 entitlement
│   └── build.sh                # 编译脚本
└── scripts/
    └── easyag-dyld.sh          # apply / revert / status / refresh
```

---

## License

MIT（与原仓库一致）。Antigravity 为 Google 产品，本项目与其官方无关。
