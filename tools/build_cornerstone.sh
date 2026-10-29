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
# Patch vtk.js's volume fragment shader (Kitware/vtk-js#3701, merged 2026-10-28, not yet in the vtk.js that
# @cornerstonejs/core pins): rayIntersectVolumeDistances divided by the ray direction, and GLSL ES leaves
# division by zero unspecified. NVIDIA's OpenGL driver (seen with 580.x, in Chromium's ANGLE-on-GL backend
# and in Firefox) returns something that makes every axis-aligned MPR ray miss the volume, so Cornerstone's
# orthographic viewports drew black. Drop this step once the pinned vtk.js carries the fix.
python3 - <<'PY'
p = "cornerstone-core.bundle.js"
s = open(p).read()
old = "vec3 invDir = 1.0 / rayDirIS;"
new = ("vec3 isParallel = vec3(equal(rayDirIS, vec3(0.0)));\n"
       "  vec3 invDir = mix(1.0 / (rayDirIS + isParallel), vec3(3.402823466e+38), isParallel);")
assert s.count(old) == 1, "vtkVolumeFS ray-direction line not found exactly once; vtk.js changed, re-check the patch"
open(p, "w").write(s.replace(old, new))
PY
cp cornerstone-core.bundle.js "$OLDPWD/vendor/cornerstone/cornerstone-core.bundle.js"
curl -sS https://raw.githubusercontent.com/cornerstonejs/cornerstone3D/main/LICENSE -o "$OLDPWD/vendor/cornerstone/LICENSE"
echo "wrote vendor/cornerstone/cornerstone-core.bundle.js ($(wc -c < cornerstone-core.bundle.js) bytes)"
