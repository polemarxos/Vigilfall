#!/bin/bash
set -e
SDK=/home/claude/android-sdk; BT=$SDK/build-tools/35.0.0; JAR=$SDK/platforms/android-34/android.jar
cd "$(dirname "$0")"; rm -rf out; mkdir -p out/gen out/classes out/res
$BT/aapt2 compile --dir res -o out/res/
$BT/aapt2 link -o out/base.apk -I $JAR --manifest AndroidManifest.xml --java out/gen out/res/*.flat --version-code ${VC:-1} --version-name ${VN:-1.0}
javac -XDstringConcat=inline -source 11 -target 11 -classpath $JAR -d out/classes $(find src out/gen -name '*.java') 2>&1 | grep -v "warning" || true
(cd out/classes && jar cf ../classes.jar .)
$BT/d8 --min-api 24 --lib $JAR --output out out/classes.jar
cd out && cp base.apk unsigned.apk && zip -q -j unsigned.apk classes.dex && cd ..
$BT/zipalign -f -p 4 out/unsigned.apk out/aligned.apk
[ -f vigilfall.keystore ] || keytool -genkeypair -keystore vigilfall.keystore -alias vigilfall -keyalg RSA -keysize 2048 -validity 36500 -storepass vigilfall -keypass vigilfall -dname "CN=Vigilfall, O=polemarxos" >/dev/null 2>&1
$BT/apksigner sign --ks vigilfall.keystore --ks-pass pass:vigilfall --key-pass pass:vigilfall --out out/Vigilfall.apk out/aligned.apk
$BT/apksigner verify --print-certs out/Vigilfall.apk | head -2
ls -la out/Vigilfall.apk
