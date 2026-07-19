#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$ROOT/dist/Add a Line-darwin-arm64/Add a Line.app"
PLIST="$APP/Contents/Info.plist"

plutil -replace CFBundleDisplayName -string "添一笔" "$PLIST"
plutil -replace CFBundleName -string "Add a Line" "$PLIST"
plutil -replace LSApplicationCategoryType -string "public.app-category.productivity" "$PLIST"

for key in \
  NSAppTransportSecurity \
  NSAudioCaptureUsageDescription \
  NSBluetoothAlwaysUsageDescription \
  NSBluetoothPeripheralUsageDescription \
  NSCameraUsageDescription \
  NSMicrophoneUsageDescription; do
  plutil -remove "$key" "$PLIST" 2>/dev/null || true
done

codesign --force --deep --sign - "$APP" >/dev/null
