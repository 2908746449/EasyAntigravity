# EasyAntigravity

<p align="center">
  <img src="assets/logo-128.png" alt="EasyAntigravity" width="96" height="96" />
</p>

<p align="center">
  <strong>自动审批 · 高危拦截 · 免 TUN 登录 · 汉化界面</strong>
</p>

<p align="center">苦反重力久矣。</p>

---

## 简介

**EasyAntigravity（EasyAG）** 是 Windows 上面向 Google Antigravity 的本地控制台，把常用增强收进一个小面板：

- **免 TUN 代理**：自动部署 `version.dll` 补丁，进程走本地 SOCKS5；客户端更新抹掉补丁后会自动从备份恢复
- **界面汉化**：通过 CDP 注入词典，实时翻译界面文案
- **自动审批**：识别权限卡片并按策略一键放行，日志里会带上请求内容摘要
- **高危拦截**：放行前按 `danger-rules.json` 规则扫描危险命令并熔断

---

## 开箱即用

1. 打开 [Releases](../../releases)，下载最新的 **`EasyAntigravity-v*-win-x64.zip`**
2. 解压到任意目录（建议路径不要过深、避免中文权限问题目录）
3. **双击 `EasyAntigravity.exe`**
4. 确认面板里的 SOCKS5 端口与本机代理一致（默认 `7890`）
5. 点击 **启动 Antigravity**

> 请使用 Release 里的 zip 完整解压，不要只拷贝一个 exe。

---

## 高危规则

规则文件为 exe 同目录下的 `danger-rules.json`（首次启动会从 `backup/` 生成）。

面板「自动化审批与高危风控」中：

- **打开规则**：用系统默认程序编辑 JSON
- **重载**：保存后立即生效

可按正则自行增删规则；顶层或单条 `enabled: false` 可停用。

---

## 自动审批选项

| 选项 | 含义 |
|------|------|
| 1 | 仅允许本次 |
| 2 | 对话中始终允许 |
| 3 | 项目中始终允许 |
| 4 | 全局始终允许（默认） |

支持中英文按钮文案，汉化开启时同样可用。

---

## 开发者（可选）

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

---

## 安全与查杀说明

本项目 **未做商业代码签名**，`pkg` 打包的单文件 Node 程序也容易被部分杀软 **误报**（常见原因：进程注入相关 `version.dll`、CDP 自动化、未签名自解压壳）。这不等于病毒。

### 如何自行核验

1. 从本仓库 **Releases** 下载 zip（勿从网盘/转载站下载）  
2. 本地计算哈希，与 Release 说明中的 SHA256 对照：

```powershell
Get-FileHash .\EasyAntigravity.exe -Algorithm SHA256
```

3. 可再上传 [VirusTotal](https://www.virustotal.com) 云查杀；多引擎结果以你上传时的报告为准。

### 构建产物哈希（v1.1.3）

| 文件 | SHA256 |
|------|--------|
| `EasyAntigravity.exe` | `7DFBF70DE95237A2000BF86036BAE307F537C8DCF0107DC96DCE0E421B5D2C48` |
| `EasyAntigravity-v1.1.3-win-x64.zip` | `1C9DA317E2975C43CFBDAC93797458014BB0329695B91D371ED14B5D3BF6734D` |

哈希随每次重新打包而变；以 **当前 Release 附件** 的哈希为准。

### 若杀软拦截

- 将解压目录加入信任/白名单，或改从源码 `npm start` 运行  
- 欢迎在 Issue 附上杀软名称、检测名、哈希与 VirusTotal 链接，便于排查误报  
- 源码可审：`server.js`、`index.html` 均在仓库内

---

## 致谢

| 来源 | 说明 |
|------|------|
| [nicktan @ linux.do](https://linux.do/t/topic/2896116) | 界面汉化词典主要来源 |
| [antigravity-2.0-no-tun-login-proxy](https://github.com/2531565073zzc-ux/antigravity-2.0-no-tun-login-proxy) | 免 TUN方案 |
| [AntiGravity-AutoAccept](https://github.com/yazanbaker94/AntiGravity-AutoAccept) | 自动审批交互思想参考 |

---

## License

[MIT](./LICENSE)

Antigravity 为 Google 产品，本项目与其官方无关。请遵守当地法律与软件许可协议。

---

<sub>🥚 想要了解这个项目诞生的背后故事？点这里发现 [隐藏彩蛋](./彩蛋.md) 🚀</sub>

