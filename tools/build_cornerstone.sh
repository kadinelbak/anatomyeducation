#!/usr/bin/env sh
# Rebuilds vendor/cornerstone/cornerstone-core.bundle.js: a single prebuilt ES
# module of @cornerstonejs/core (MIT) so the app itself needs no build step,
# the same way vendor/three is a prebuilt copy of Three.js in anatomy-app.
# Needs Node 18+ and network access to registry.npmjs.org. Run from imaging/.
set -eu
work=$(mktemp -d)
cd "$work"
npm init -y >/dev/null
npm i --no-audit --no-fund @cornerstonejs/core@5.11.7 esbuild@0.28.2 events url >/dev/null
cat > entry.js <<'JS'
export { init, RenderingEngine, Enums, volumeLoader, imageLoader, cache, setVolumesForViewports, addVolumesToViewports, utilities, metaData, getRenderingEngine, eventTarget, CONSTANTS } from "@cornerstonejs/core";
JS
npx esbuild entry.js --bundle --format=esm --minify --target=es2022 --outfile=cornerstone-core.bundle.js
cp cornerstone-core.bundle.js "$OLDPWD/vendor/cornerstone/cornerstone-core.bundle.js"
curl -sS https://raw.githubusercontent.com/cornerstonejs/cornerstone3D/main/LICENSE -o "$OLDPWD/vendor/cornerstone/LICENSE"
echo "wrote vendor/cornerstone/cornerstone-core.bundle.js ($(wc -c < cornerstone-core.bundle.js) bytes)"
