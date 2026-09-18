#!/bin/sh
# =============================================================================
# install.sh — 一键安装 EasyAntigravity macOS 版
#
#   1. 检查 node 运行时
#   2. 安装 npm 依赖 (ws)
#   3. 编译 SOCKS5 拦截 dylib
#   4. 生成双击即用的 EasyAntigravity.app（无终端黑框）
# =============================================================================
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
APP_DST="$HOME/Applications/EasyAntigravity.app"

say()  { printf '%s\n' "$*"; }
ok()   { printf '\033[32m%s\033[0m\n' "$*"; }
warn() { printf '\033[33m%s\033[0m\n' "$*"; }
err()  { printf '\033[31m%s\033[0m\n' "$*" >&2; }

# ---------------------------------------------------------------------------
# 1) node
# ---------------------------------------------------------------------------
find_node() {
    for c in \
        "$HOME/.local/bin/node" \
        /opt/homebrew/bin/node \
        /usr/local/bin/node \
        /opt/homebrew/opt/node/bin/node
    do
        [ -x "$c" ] && { printf '%s' "$c"; return 0; }
    done
    # WorkBuddy 托管运行时兜底
    for c in "$HOME"/.workbuddy/binaries/node/versions/*/bin/node; do
        [ -x "$c" ] && { printf '%s' "$c"; return 0; }
    done
    command -v node 2>/dev/null && return 0
    return 1
}

NODE="$(find_node)" || { err "未找到 node。请先安装 Node.js 18+ (brew install node)"; exit 1; }
ok "node: $NODE ($("$NODE" -v))"

# ---------------------------------------------------------------------------
# 2) 依赖
# ---------------------------------------------------------------------------
if [ ! -d "$HERE/node_modules/ws" ]; then
    say "==> 安装 npm 依赖"
    ( cd "$HERE" && "$NODE" "$(dirname "$NODE")/npm" install --no-audit --no-fund 2>/dev/null \
      || npm install --no-audit --no-fund ) || { err "npm install 失败"; exit 1; }
fi
[ -d "$HERE/node_modules/ws" ] && ok "依赖 ws: 就绪" || { err "依赖 ws 缺失"; exit 1; }

# ---------------------------------------------------------------------------
# 3) dylib
# ---------------------------------------------------------------------------
if [ ! -f "$HERE/native/libeasyag_proxy.dylib" ]; then
    say "==> 编译 SOCKS5 拦截 dylib"
    sh "$HERE/native/build.sh" || { err "dylib 编译失败（需要 Xcode Command Line Tools: xcode-select --install）"; exit 1; }
fi
ok "dylib: 就绪"

# ---------------------------------------------------------------------------
# 4) .app bundle
# ---------------------------------------------------------------------------
say "==> 生成 $APP_DST"
rm -rf "$APP_DST"
mkdir -p "$APP_DST/Contents/MacOS" "$APP_DST/Contents/Resources"

cat > "$APP_DST/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>EasyAntigravity</string>
  <key>CFBundleDisplayName</key><string>EasyAntigravity</string>
  <key>CFBundleIdentifier</key><string>local.easyantigravity.mac</string>
  <key>CFBundleVersion</key><string>1.1.4</string>
  <key>CFBundleShortVersionString</key><string>1.1.4</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>EasyAntigravity</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>LSUIElement</key><false/>
</dict>
</plist>
PLIST

cat > "$APP_DST/Contents/MacOS/EasyAntigravity" <<LAUNCHER
#!/bin/sh
# EasyAntigravity macOS 启动器
PROJ="$HERE"

# 运行时再找一次 node，避免安装后 node 路径变化
NODE=""
for c in "$NODE" "\$HOME/.local/bin/node" /opt/homebrew/bin/node /usr/local/bin/node; do
    [ -x "\$c" ] && { NODE="\$c"; break; }
done
if [ -z "\$NODE" ]; then
    for c in "\$HOME"/.workbuddy/binaries/node/versions/*/bin/node; do
        [ -x "\$c" ] && { NODE="\$c"; break; }
    done
fi
if [ -z "\$NODE" ]; then
    NODE="\$(command -v node)"
fi
if [ -z "\$NODE" ]; then
    osascript -e 'display alert "EasyAntigravity" message "未找到 node 运行时，请安装 Node.js 后重试。"'
    exit 1
fi

cd "\$PROJ" || exit 1
exec "\$NODE" "\$PROJ/server.js"
LAUNCHER
chmod 755 "$APP_DST/Contents/MacOS/EasyAntigravity"

# 图标
if [ -f "$HERE/assets/logo-master.png" ]; then
    TMPI="$(mktemp -d)"
    mkdir -p "$TMPI/AppIcon.iconset"
    SRC="$HERE/assets/logo-master.png"
    for s in 16 32 64 128 256 512; do
        sips -z $s $s "$SRC" --out "$TMPI/AppIcon.iconset/icon_${s}x${s}.png" >/dev/null 2>&1
        d=$((s * 2))
        sips -z $d $d "$SRC" --out "$TMPI/AppIcon.iconset/icon_${s}x${s}@2x.png" >/dev/null 2>&1
    done
    iconutil -c icns "$TMPI/AppIcon.iconset" -o "$APP_DST/Contents/Resources/AppIcon.icns" 2>/dev/null
    rm -rf "$TMPI"
fi

# 去掉隔离属性，避免「已损坏」提示
xattr -dr com.apple.quarantine "$APP_DST" 2>/dev/null
codesign --force --deep --sign - "$APP_DST" >/dev/null 2>&1

ok "✅ 安装完成: $APP_DST"

# 终端启动脚本
cat > "$HERE/start.command" <<CMD
#!/bin/sh
cd "$HERE" && exec "$NODE" "$HERE/server.js"
CMD
chmod 755 "$HERE/start.command"

say ""
say "启动方式："
say "  1) 访达 → 应用程序 → EasyAntigravity  （推荐，无终端窗口）"
say "  2) 双击 $HERE/start.command"
say "  3) 终端：cd \"$HERE\" && npm start"
say ""
say "首次使用建议在面板里选「深度注入 · DYLD 劫持模式」并点「安装注入」。"
