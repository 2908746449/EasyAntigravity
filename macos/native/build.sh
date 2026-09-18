#!/bin/sh
# 编译 macOS SOCKS5 拦截 dylib
set -e

HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="${1:-$HERE/libeasyag_proxy.dylib}"

echo "==> 编译 $OUT"
clang -dynamiclib -O2 -fPIC -Wall \
  -Wno-deprecated-declarations -Wno-unused-function \
  -arch arm64 -arch x86_64 \
  -mmacosx-version-min=11.0 \
  -install_name "@rpath/libeasyag_proxy.dylib" \
  -o "$OUT" "$HERE/proxyhook.c"

echo "==> ad-hoc 签名"
codesign --force --sign - "$OUT" >/dev/null 2>&1 || true

echo "==> 完成"
file "$OUT"
codesign -dvv "$OUT" 2>&1 | head -3
