#!/bin/bash
# 用 macOS 自带工具把 icon-master.png 转成 icon.icns
set -e
cd "$(dirname "$0")/../assets"
rm -rf icon.iconset icon.icns
mkdir -p icon.iconset
sips -z 16 16 icon-master.png --out icon.iconset/icon_16x16.png > /dev/null
sips -z 32 32 icon-master.png --out icon.iconset/icon_16x16@2x.png > /dev/null
sips -z 32 32 icon-master.png --out icon.iconset/icon_32x32.png > /dev/null
sips -z 64 64 icon-master.png --out icon.iconset/icon_32x32@2x.png > /dev/null
sips -z 128 128 icon-master.png --out icon.iconset/icon_128x128.png > /dev/null
sips -z 256 256 icon-master.png --out icon.iconset/icon_128x128@2x.png > /dev/null
sips -z 256 256 icon-master.png --out icon.iconset/icon_256x256.png > /dev/null
sips -z 512 512 icon-master.png --out icon.iconset/icon_256x256@2x.png > /dev/null
sips -z 512 512 icon-master.png --out icon.iconset/icon_512x512.png > /dev/null
sips -z 1024 1024 icon-master.png --out icon.iconset/icon_512x512@2x.png > /dev/null
iconutil -c icns icon.iconset -o icon.icns
rm -rf icon.iconset
sips -z 512 512 icon-master.png --out icon-512.png > /dev/null
echo "已生成 assets/icon.icns 和 assets/icon-512.png"
