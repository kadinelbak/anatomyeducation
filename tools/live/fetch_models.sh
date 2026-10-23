#!/bin/sh
# Fetches the MediaPipe model files into assets/ml/ (see assets/ml/README.md for hashes).
set -e
cd "$(dirname "$0")/../../assets/ml"
B=https://storage.googleapis.com/mediapipe-models
curl -fsSLO $B/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task
curl -fsSLO $B/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task
sha256sum -c <<H || echo "WARNING: hashes differ from README (upstream 'latest' changed?)"
59929e1d1ee95287735ddd833b19cf4ac46d29bc7afddbbf6753c459690d574a  pose_landmarker_lite.task
fbc2a30080c3c557093b5ddfc334698132eb341044ccee322ccf8bcf3607cde1  hand_landmarker.task
H
