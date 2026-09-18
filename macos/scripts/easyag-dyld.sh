#!/bin/sh
# =============================================================================
# easyag-dyld.sh — EasyAntigravity macOS「深度注入模式」安装 / 还原 / 状态
#
# 这是 Windows 版 version.dll 补丁在 macOS 上的严格等价物：
#   Windows: 把 version.dll 丢进 Antigravity 安装目录，劫持 winsock connect()
#   macOS  : 把 language_server 换成注入壳，重签后经 DYLD 劫持 libsystem connect()
#
# 用法：
#   ./easyag-dyld.sh apply    [代理端口]   安装（默认 7890）
#   ./easyag-dyld.sh revert                还原成官方原版
#   ./easyag-dyld.sh status                查看当前状态
#   ./easyag-dyld.sh refresh [代理端口]    仅刷新配置（不动二进制）
#
# 全部改动都在用户目录内可回滚；原始二进制在替换前完整备份。
# =============================================================================
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
PROJ="$(cd "$HERE/.." && pwd)"

SUPPORT="$HOME/Library/Application Support/EasyAntigravity"
CONF="$SUPPORT/easyag-proxy.json"
LOG="$SUPPORT/language_server.easyag.log"
STATE="$SUPPORT/state.json"
ORIG_BACKUP="$SUPPORT/backup"
DYLIB="$PROJ/native/libeasyag_proxy.dylib"
ENTITLEMENTS="$PROJ/native/entitlements.plist"
WRAPPER_MARK="# EASYG_WRAPPER_V1"

say()  { printf '%s\n' "$*"; }
warn() { printf '\033[33m%s\033[0m\n' "$*"; }
err()  { printf '\033[31m%s\033[0m\n' "$*" >&2; }
ok()   { printf '\033[32m%s\033[0m\n' "$*"; }

# ---------------------------------------------------------------------------
# 定位 Antigravity.app
# ---------------------------------------------------------------------------
find_app() {
    for p in \
        "/Applications/Antigravity.app" \
        "$HOME/Applications/Antigravity.app"
    do
        [ -d "$p" ] && { printf '%s' "$p"; return 0; }
    done
    return 1
}

app_version() {
    /usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" \
        "$1/Contents/Info.plist" 2>/dev/null || printf 'unknown'
}

app_cdhash() {
    codesign -dvvv "$1/Contents/MacOS/Antigravity" 2>&1 \
        | sed -n 's/^CDHash=//p' | head -1
}

is_wrapper() {
    [ -f "$1" ] || return 1
    head -2 "$1" 2>/dev/null | grep -q "$WRAPPER_MARK"
}

# ---------------------------------------------------------------------------
# 写配置（dylib 通过 EASYG_CONF 读取）
# ---------------------------------------------------------------------------
write_conf() {
    port="$1"
    mkdir -p "$SUPPORT"
    cat > "$CONF" <<EOF
{
  "_comment": "EasyAntigravity macOS no-TUN proxy config (dyld mode)",
  "proxy": { "host": "127.0.0.1", "port": $port, "type": "socks5" },
  "proxy_rules": {
    "dns_mode": "remote",
    "udp_mode": "block",
    "use_default_private": true,
    "bypass": [
      "127.0.0.0/8", "10.0.0.0/8", "172.16.0.0/12",
      "192.168.0.0/16", "169.254.0.0/16",
      "::1/128", "fc00::/7", "fe80::/10"
    ]
  },
  "log_level": "info",
  "traffic_logging": false
}
EOF
    ok "配置已写入: $CONF (socks5 127.0.0.1:$port)"
}

# ---------------------------------------------------------------------------
# 生成注入壳
# ---------------------------------------------------------------------------
write_wrapper() {
    bin="$1"
    real="$2"
    cat > "$bin" <<EOF
#!/bin/sh
$WRAPPER_MARK
# EasyAntigravity macOS no-TUN 注入壳 —— 请勿手工编辑
# 原版二进制保留在: $real
EASYG_DYLIB="$DYLIB"
EASYG_REAL="$real"

export EASYG_CONF="$CONF"
export EASYG_LOG="$LOG"
export EASYG_UDP_BLOCK="1"

if [ -f "\$EASYG_DYLIB" ]; then
    DYLD_INSERT_LIBRARIES="\$EASYG_DYLIB\${DYLD_INSERT_LIBRARIES:+:\$DYLD_INSERT_LIBRARIES}"
    export DYLD_INSERT_LIBRARIES
fi
exec "\$EASYG_REAL" "\$@"
EOF
    chmod 755 "$bin"
}

# ---------------------------------------------------------------------------
# apply
# ---------------------------------------------------------------------------
cmd_apply() {
    port="${1:-7890}"

    APP="$(find_app)" || { err "未找到 Antigravity.app（/Applications 或 ~/Applications）"; exit 1; }
    BIN="$APP/Contents/Resources/bin/language_server"
    REAL="$BIN.easyag-real"

    say "Antigravity: $APP  (v$(app_version "$APP"))"

    # 1) 确保 dylib 存在
    if [ ! -f "$DYLIB" ]; then
        say "==> dylib 不存在，开始编译"
        sh "$PROJ/native/build.sh" || { err "dylib 编译失败"; exit 1; }
    fi

    # 2) 运行中检查
    if pgrep -f "Antigravity.app/Contents/MacOS/Antigravity" >/dev/null 2>&1; then
        warn "⚠ 检测到 Antigravity 正在运行，请先完全退出再执行 apply"
        exit 2
    fi

    # 3) 备份原始二进制（只备份一次）
    mkdir -p "$ORIG_BACKUP"
    if [ ! -f "$REAL" ]; then
        say "==> 备份原始 language_server → $REAL"
        cp -p "$BIN" "$REAL" || { err "备份失败"; exit 1; }
        cp -p "$BIN" "$ORIG_BACKUP/language_server.orig"
        ok  "原始二进制已留档: $ORIG_BACKUP/language_server.orig"
    else
        say "==> 已存在备份 $REAL，跳过"
    fi

    # 4) 重签（关键：加两个 entitlement 才能让 dyld 接受 DYLD_INSERT_LIBRARIES）
    say "==> 重签名 language_server（ad-hoc + dyld entitlement）"
    codesign --force --sign - --entitlements "$ENTITLEMENTS" "$REAL" 2>&1 | sed 's/^/    /'

    # 5) 装注入壳
    say "==> 安装注入壳 → $BIN"
    write_wrapper "$BIN" "$REAL"

    # 6) 配置
    write_conf "$port"

    # 7) 状态落盘
    mkdir -p "$SUPPORT"
    cat > "$STATE" <<EOF
{
  "mode": "dyld",
  "app": "$APP",
  "appVersion": "$(app_version "$APP")",
  "appCDHash": "$(app_cdhash "$APP")",
  "port": $port,
  "appliedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "dylib": "$DYLIB"
}
EOF

    ok ""
    ok "✅ 深度注入模式已安装"
    say "   language_server  → 注入壳"
    say "   原始二进制        → $REAL"
    say "   SOCKS5            → 127.0.0.1:$port"
    say "   注入日志          → $LOG"
    say ""
    say "现在启动 Antigravity 即可生效。还原请执行: $0 revert"
}

# ---------------------------------------------------------------------------
# revert
# ---------------------------------------------------------------------------
cmd_revert() {
    APP="$(find_app)" || { err "未找到 Antigravity.app"; exit 1; }
    BIN="$APP/Contents/Resources/bin/language_server"
    REAL="$BIN.easyag-real"

    if pgrep -f "Antigravity.app/Contents/MacOS/Antigravity" >/dev/null 2>&1; then
        warn "⚠ Antigravity 正在运行，请先完全退出"
        exit 2
    fi

    if [ -f "$REAL" ]; then
        say "==> 还原原始 language_server"
        rm -f "$BIN"
        mv "$REAL" "$BIN"
        chmod 755 "$BIN"
        ok "已还原（签名回到 Google 原版）"
        codesign -dvv "$BIN" 2>&1 | grep -E "^Authority|^TeamIdentifier" | sed 's/^/    /'
    else
        warn "未发现备份 $REAL，可能本来就没装过"
    fi

    rm -f "$STATE"
    ok "已切换回官方原版状态"
}

# ---------------------------------------------------------------------------
# status
# ---------------------------------------------------------------------------
cmd_status() {
    APP="$(find_app)" || { err "未找到 Antigravity.app"; exit 1; }
    BIN="$APP/Contents/Resources/bin/language_server"
    REAL="$BIN.easyag-real"

    say "Antigravity : $APP"
    say "版本        : $(app_version "$APP")"
    say "CDHash      : $(app_cdhash "$APP")"
    say ""
    if is_wrapper "$BIN"; then
        ok  "注入状态    : ✅ 已安装（深度注入模式）"
    else
        say "注入状态    : ❌ 未安装（官方原版）"
    fi
    say "备份二进制  : $([ -f "$REAL" ] && echo "存在 $REAL" || echo "无")"
    say "dylib       : $([ -f "$DYLIB" ] && echo "存在 $DYLIB" || echo "不存在（未编译）")"
    say "配置        : $([ -f "$CONF" ] && echo "$CONF" || echo "无")"
    say "注入日志    : $([ -f "$LOG" ] && echo "$LOG ($(wc -l < "$LOG" | tr -d ' ') 行)" || echo "无")"
    if [ -f "$BIN" ]; then
        say ""
        say "language_server 签名："
        codesign -dvv "$BIN" 2>&1 | grep -E "^Authority|^TeamIdentifier" | sed 's/^/    /' || say "    (脚本，无签名)"
    fi
}

# ---------------------------------------------------------------------------
case "${1:-status}" in
    apply)   shift; cmd_apply "${1:-7890}" ;;
    revert)  cmd_revert ;;
    status)  cmd_status ;;
    refresh) shift; write_conf "${1:-7890}" ;;
    *)
        say "用法: $0 {apply [port] | revert | status | refresh [port]}"
        exit 1
        ;;
esac
