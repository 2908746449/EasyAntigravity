# EasyAntigravity

<p align="center">
  <img src="assets/logo-128.png" alt="EasyAntigravity" width="96" height="96" />
</p>

<p align="center">
  <strong>自动审批 · 高危拦截 · 免 TUN 登录 · 汉化界面</strong>
</p>

<p align="center">
  苦反重力久矣。
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Platform-Windows%20x64-blue?logo=windows" alt="Platform" />
  <img src="https://img.shields.io/badge/License-MIT-green" alt="License" />
  <img src="https://img.shields.io/badge/version-1.1.0-orange" alt="Version" />
</p>

---

## 这是什么

**EasyAntigravity（EasyAG）** 是 Windows 上面向 [Google Antigravity](https://antigravity.google) 的本地启动器与增强控制台。

把「免 TUN 代理注入、补丁自愈、界面汉化、权限自动审批、高危命令熔断」收进一个小面板，减少手搓配置和反复点「允许」。

| 能力 | 说明 |
|------|------|
| 免 TUN 代理 | 部署 `version.dll` + `config.json`，将 Antigravity / language_server 等进程重定向到本地 SOCKS5 |
| 补丁自愈 | 客户端静默更新抹掉补丁时，启动时从 `backup/` 自动恢复 |
| 界面汉化 | 通过 CDP 向渲染进程注入词典，实时替换 DOM 文案（约 2200+ 词条） |
| 自动审批 | 识别权限卡片，按选项 1–4 自动选定并点击提交；日志带请求摘要 |
| 高危熔断 | 放行前用 `danger-rules.json` 正则扫描命令，命中则拦截 |
| 运行审计 | SSE 日志；可选中复制，一键复制到剪贴板 |

---

## 环境要求

- Windows 10 / 11 x64
- 已安装 Antigravity（默认 `%LOCALAPPDATA%\Programs\antigravity`）
- 本地代理提供 SOCKS5，例如 Clash / Mihomo 的 `127.0.0.1:7890`
- **Microsoft Visual C++ 2015–2022 Redistributable (x64)**  
  `version.dll` 依赖系统 `MSVCP140.dll`。若该文件损坏或过旧（例如 `14.00.24215.1`），Antigravity 启动即 `0xC0000005`。  
  下载：https://aka.ms/vs/17/release/vc_redist.x64.exe
- Microsoft Edge（控制台以应用模式打开）

---

## 快速开始

### 用户（推荐）

1. 从 [Releases](../../releases) 下载 `EasyAntigravity-v*-win-x64.zip`
2. 解压到任意目录（不要只拷一个 exe）
3. **双击 `EasyAntigravity.exe`**（会自动隐藏控制台）
4. 面板中确认 SOCKS5 端口与本机代理一致
5. 点击 **启动 Antigravity**

备用启动：`启动EasyAG.vbs` / `.ps1` / `.cmd`（效果相同）。

### 开发者

```powershell
git clone https://github.com/DSDS-CMHL/EasyAntigravity.git
cd EasyAntigravity
npm install
npm start
```

打包：

```powershell
npx pkg@5.8.1 . --targets node18-win-x64 --output EasyAntigravity.exe --compress GZip
```

> exe 必须与 `index.html`、`dicts/`、`backup/`、`version.dll`、`config.json`、`danger-rules.json` 同目录才能完整运行；请使用 Release 里的 zip，而不是单独下载 exe。

---

## 目录结构

```text
EasyAntigravity/
├─ EasyAntigravity.exe     # 主程序（双击启动，无黑框）
├─ server.js               # 本地 HTTP + CDP 服务
├─ index.html              # 控制台 UI
├─ backup/                 # 自愈备份（version.dll / config.json / danger-rules.json）
├─ dicts/                  # 汉化词典
└─ assets/                 # Logo 等资源
```

说明：

- 代理补丁从 `backup/` 部署到 Antigravity 安装目录，并在被更新抹掉后自动恢复
- 首次启动会把 `backup/danger-rules.json` 生成为同目录的 `danger-rules.json`，之后以该文件为准（可自行编辑，面板里可「打开规则 / 重载」）
- 无需额外启动器，双击 exe 即可
---

## 高危规则 `danger-rules.json`

规则放在 exe 同目录，格式类似 VPN 分流规则，可自行增删改：

```json
{
  "version": 1,
  "enabled": true,
  "rules": [
    {
      "id": "rm-rf",
      "name": "递归强制删除",
      "description": "rm -rf / rm -fr",
      "pattern": "\\brm\\s+(-[a-zA-Z]*r[a-zA-Z]*f|--force)",
      "flags": "i",
      "enabled": true
    }
  ]
}
```

| 字段 | 说明 |
|------|------|
| 顶层 `enabled` | `false` 时关闭整组熔断 |
| `rules[].pattern` | 正则，匹配待执行命令 |
| `rules[].flags` | 默认 `i` |
| `rules[].enabled` | 单条启停 |

面板「自动化审批与高危风控」提供 **打开规则 / 重载**。  
`backup/danger-rules.json` 为自愈备份。

---

## 自动审批选项

| 选项 | 含义 |
|------|------|
| 1 | 仅允许本次 |
| 2 | 对话中始终允许 |
| 3 | 项目中始终允许 |
| 4 | 全局始终允许（默认） |

匹配覆盖中英文（`Submit` / `提交` / `Always allow` / `始终允许` 等），兼容汉化后的 DOM。  
日志格式示例：`批准权限 · 选项[4] · <请求摘要>`。

---

## 常见问题

**启动 Antigravity 后立刻退出（0xC0000005）**  
优先检查 `C:\Windows\System32\MSVCP140.dll` 版本是否为 `14.00.24215.1` 之类的旧文件；修复 VC++ x64 运行库后再试。对照：去掉 `version.dll` 能启动、放上就崩，多半是 CRT 问题。

**任务栏图标是 Edge**  
Edge 应用模式受浏览器限制，部分版本任务栏图标无法完全自定义。

**汉化开着时自动审批异常**  
可暂时关闭「实时 DOM 字典翻译」；或更新 `dicts/` 词典后重启 EasyAG。

**已有 TUN 时还要不要 DLL？**  
原版 `version.dll` 面向无 TUN 场景。若已开 TUN 且 Google 可达，可不注入 DLL，仅用本工具做汉化 / 自动审批。

---

## 安全说明

- 默认开启高危命令熔断，请按需自定义 `danger-rules.json`
- 自动审批会授予 AI 较高文件 / 命令权限，请在可信项目中使用
- `version.dll` 与词典请从本仓库或可信渠道获取

---

## 致谢

本项目站在许多优秀开源与社区工作的肩膀上：

| 来源 | 说明 |
|------|------|
| [nicktan @ linux.do「Antigravity 汉化」](https://linux.do/t/topic/2896116) | 界面汉化词典主要来源 |
| [antigravity-2.0-no-tun-login-proxy](https://github.com/2531565073zzc-ux/antigravity-2.0-no-tun-login-proxy) | 免 TUN `version.dll` 方案与配置思路 |
| [AntiGravity-AutoAccept](https://github.com/yazanbaker94/AntiGravity-AutoAccept) | 自动审批交互思想的参考（该实现为插件形态，面向 Antigravity IDE 场景） |
| [yuaotian/antigravity-proxy](https://github.com/yuaotian/antigravity-proxy) | 进程代理注入思路参考 |

以及 Edge / CDP / MinHook / nlohmann/json 等基础组件的作者们。

---

## License

[MIT](./LICENSE)

仅供学习与个人使用。Antigravity 为 Google 产品，本项目与其官方无关。  
使用注入组件前请遵守当地法律与软件许可协议。
