#!/bin/bash
# Construit les apps natives de NetBench (sur un Mac) :
#   dist/NetBench-mac.zip : NetBench.app universelle (Apple Silicon + Intel), fenêtre WebKit du système
#   dist/NetBench.exe     : Windows 10/11 (x64, marche aussi sur ARM), fenêtre WebView2 du système
# Outils : Xcode Command Line Tools (swiftc) et Go.   Usage : tools/build-native.sh 1.8.0 dist
set -euo pipefail
VER="$1"; OUT="$(cd "$2" && pwd)"; ROOT="$(cd "$(dirname "$0")/.." && pwd)"
B="$(mktemp -d)"; trap 'rm -rf "$B"' EXIT

# ---- macOS
# Apple Silicon : macOS 11+ ; Intel : macOS 13+ (bibliothèques Swift des outils en ligne de commande)
xcrun swiftc -O -target arm64-apple-macos11 -o "$B/NetBench-arm64" "$ROOT/native-src/mac/main.swift"
xcrun swiftc -O -target x86_64-apple-macos13 -o "$B/NetBench-x86_64" "$ROOT/native-src/mac/main.swift"
APP="$B/NetBench.app"; mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
lipo -create -output "$APP/Contents/MacOS/NetBench" "$B/NetBench-arm64" "$B/NetBench-x86_64"
cp "$ROOT/assets/icon.icns" "$APP/Contents/Resources/icon.icns"
cat > "$APP/Contents/Info.plist" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleName</key><string>NetBench</string><key>CFBundleDisplayName</key><string>NetBench</string>
<key>CFBundleIdentifier</key><string>fr.nesaris.netbench</string><key>CFBundleExecutable</key><string>NetBench</string>
<key>CFBundleIconFile</key><string>icon</string><key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>$VER</string><key>CFBundleVersion</key><string>$VER</string>
<key>LSMinimumSystemVersion</key><string>11.0</string><key>LSMinimumSystemVersionByArchitecture</key><dict><key>arm64</key><string>11.0</string><key>x86_64</key><string>13.0</string></dict><key>NSHighResolutionCapable</key><true/>
<key>LSApplicationCategoryType</key><string>public.app-category.utilities</string>
<key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
<key>NSHumanReadableCopyright</key><string>Licence MIT — github.com/Nesaris/netbench</string>
</dict></plist>
PL
codesign --force --sign - "$APP"
rm -f "$OUT/NetBench-mac.zip"; ditto -c -k --keepParent "$APP" "$OUT/NetBench-mac.zip"

# ---- Windows
cd "$ROOT/native-src/win"
sed -i '' -E "s/\"(file|product)_version\": \"[0-9.]+\"/\"\1_version\": \"$VER.0\"/g" winres.json
[ -f go.mod ] || { go mod init github.com/Nesaris/netbench/native-src/win >/dev/null 2>&1; }
go mod tidy >/dev/null 2>&1
go run github.com/tc-hib/go-winres@v0.3.3 make --in winres.json --arch amd64 --out rsrc
GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -trimpath -ldflags "-H windowsgui -s -w" -o "$OUT/NetBench.exe" .
rm -f rsrc_windows_*.syso
echo "Apps natives : $OUT/NetBench-mac.zip, $OUT/NetBench.exe"
