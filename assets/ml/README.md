# MediaPipe model files (Live mode)

Used by `src/live/tracking.js`, loaded from this folder at runtime (no third-party fetches).
Licence: Apache License 2.0 (Google LLC / MediaPipe). Runtime: `vendor/mediapipe/` (see its VERSION).
Re-fetch with `tools/live/fetch_models.sh`.

| File | Bytes | sha256 | Source |
|---|---|---|---|
| pose_landmarker_lite.task | 5777746 | 59929e1d1ee95287735ddd833b19cf4ac46d29bc7afddbbf6753c459690d574a | https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task |
| hand_landmarker.task | 7819105 | fbc2a30080c3c557093b5ddfc334698132eb341044ccee322ccf8bcf3607cde1 | https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task |
| face_landmarker.task | 3758596 | 64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff | https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task |

Downloaded 2026-10-23 (the "latest" alias may change upstream; the hashes above pin what was tested).
