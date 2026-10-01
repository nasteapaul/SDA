#!/usr/bin/env bash
# Builds the Android app (Budget.apk) without Android Studio or the SDK installer.
# Needs: bash, curl, git, python3, a JDK (11+). Tools are downloaded once into .tools/.
#   ./build.sh                      -> build/Budget.apk
#   VERSION_CODE=2 VERSION_NAME=1.1 KEYSTORE_PASS=... ./build.sh
set -euo pipefail
cd "$(dirname "$0")"

TOOLS=.tools
OUT=build
VERSION_CODE=${VERSION_CODE:-1}
VERSION_NAME=${VERSION_NAME:-1.0}
KEYSTORE=${KEYSTORE:-keystore/budget.p12}
KEYSTORE_PASS=${KEYSTORE_PASS:-budget-planner}
M=https://repo1.maven.org/maven2
mkdir -p "$TOOLS"

fetch() { [ -s "$TOOLS/$1" ] || curl -fsSL --retry 5 --retry-delay 10 --retry-all-errors -o "$TOOLS/$1" "$2"; }
echo "• tools"
fetch apktool-lib.jar "$M/org/apktool/apktool-lib/3.0.3/apktool-lib-3.0.3.jar"   # ships a prebuilt aapt2
fetch dx.jar "$M/com/jakewharton/android/repackaged/dalvik-dx/16.0.1/dalvik-dx-16.0.1.jar"
fetch apksig.jar "$M/com/android/tools/build/apksig/2.3.0/apksig-2.3.0.jar"
if [ ! -x "$TOOLS/aapt2" ]; then
  case "$(uname -s)" in Darwin) os=macosx ;; *) os=linux ;; esac
  unzip -p "$TOOLS/apktool-lib.jar" "prebuilt/$os/aapt2" > "$TOOLS/aapt2" && chmod +x "$TOOLS/aapt2"
fi
if [ ! -s "$TOOLS/android.jar" ]; then   # official SDK platform jar (API 34)
  rm -rf "$TOOLS/platforms"
  git clone -q --depth 1 --filter=blob:none --sparse https://github.com/Sable/android-platforms "$TOOLS/platforms"
  git -C "$TOOLS/platforms" sparse-checkout set android-34
  cp "$TOOLS/platforms/android-34/android.jar" "$TOOLS/android.jar" && rm -rf "$TOOLS/platforms"
fi

echo "• resources"
rm -rf "$OUT" && mkdir -p "$OUT/classes"
"$TOOLS/aapt2" compile --dir res -o "$OUT/res.zip"
"$TOOLS/aapt2" link -o "$OUT/resources.apk" -I "$TOOLS/android.jar" --manifest AndroidManifest.xml \
  --min-sdk-version 24 --target-sdk-version 34 --version-code "$VERSION_CODE" --version-name "$VERSION_NAME" "$OUT/res.zip"

echo "• code"
javac -nowarn -Xlint:-options -source 8 -target 8 -bootclasspath "$TOOLS/android.jar" -d "$OUT/classes" $(find src -name '*.java')
java -cp "$TOOLS/dx.jar" com.android.dx.command.Main --dex --min-sdk-version=24 --output="$OUT/classes.dex" "$OUT/classes"

echo "• package"
python3 tools/package.py "$OUT/resources.apk" "$OUT/classes.dex" "$OUT/unsigned.apk"

echo "• sign"
if [ ! -f "$KEYSTORE" ]; then
  mkdir -p "$(dirname "$KEYSTORE")"
  keytool -genkeypair -keystore "$KEYSTORE" -storetype PKCS12 -alias budget -keyalg RSA -keysize 2048 \
    -validity 10000 -dname "CN=Budget Planner" -storepass "$KEYSTORE_PASS" -keypass "$KEYSTORE_PASS" 2>/dev/null
  echo "  created signing key $KEYSTORE — keep it: updates must be signed with the same key"
fi
java --add-exports java.base/sun.security.x509=ALL-UNNAMED --add-exports java.base/sun.security.pkcs=ALL-UNNAMED \
  --add-exports java.base/sun.security.util=ALL-UNNAMED -cp "$TOOLS/apksig.jar" tools/Sign.java "$KEYSTORE" "$KEYSTORE_PASS" budget "$OUT/unsigned.apk" "$OUT/Budget.apk"
python3 tools/package.py --check "$OUT/Budget.apk"
echo "✓ $(pwd)/$OUT/Budget.apk ($(du -h "$OUT/Budget.apk" | cut -f1))"
