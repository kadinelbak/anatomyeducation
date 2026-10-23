# Live mode release checklist

- [ ] All tests green: `tools/smoke_test.mjs`, `tools/live/smoke_test_live.mjs` (desktop and `W=390 H=844`), every other `tools/live/*_test.mjs`.
- [ ] No cross-origin requests while Live is open (the smoke test checks this; only 127.0.0.1 plus the existing GoatCounter and Kit scripts).
- [ ] Credits spans in the app and `NOTICE.md` rows for every new dataset and for the MediaPipe models.
- [ ] Each model file under 15 MB (`ls -l assets/ml vendor/mediapipe`).
- [ ] Phone layout checked at 375 px wide: no horizontal scroll, controls reachable.
- [ ] Camera stops on every exit path: brand button, switching mode, tab hidden, page close, permission denied, tracker error.
- [ ] `prefers-reduced-motion` respected (no non-essential animation).
- [ ] Fallback card shown without a camera, without HTTPS, or without WebGL2.
- [ ] Privacy text in the app, `README.md` and `NOTICE.md` matches what the code does.
