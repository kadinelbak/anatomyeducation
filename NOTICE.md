# Notices and licences

The app's code is released under the PolyForm Noncommercial License 1.0.0 (see `LICENSE`), and the project's own content (question text, labels, maps, body map, stylised cells and diagrams) under CC BY-NC-SA 4.0 (see `LICENSE-CONTENT.md`). The app is run as a non-commercial, free educational project. Third-party material keeps its own licence, listed below and not covered by either project licence. The same list is shown in the app under Credits.

| Material | Licence | Credit |
|---|---|---|
| BodyParts3D models, body map outline | CC BY 4.0 | The Database Center for Life Science (DBCLS) |
| Open3DModel arm and lower limb | CC BY-SA 4.0 | Leiden, Utrecht, Maastricht, KU Leuven KULAK |
| Z-Anatomy neck and head | CC BY-SA 4.0 | Z-Anatomy; derived from BodyParts3D |
| TotalSegmentator CT, X-ray and ultrasound simulations | CC BY 4.0 | Wasserthal et al., Radiology: AI 2023 |
| TotalSegmentator MRI | **CC BY-NC-SA 4.0, non-commercial only** | Akinci D'Antonoli et al. |
| Medical Segmentation Decathlon heart, hippocampus, prostate | CC BY-SA 4.0 | Antonelli et al. |
| ICBM 152 2009c brain template | MNI terms, free use with attribution | Fonov et al., Montreal Neurological Institute |
| Allen Cell hiPSC models | CC BY 4.0 | Allen Institute for Cell Science; Viana et al., Nature 2023 |
| GTEx histology via NCI Imaging Data Commons | CC BY 4.0 | GTEx Consortium |
| Bone histology | CC0 | Berkshire Community College Bioscience Image Library |
| Stylised cell models and diagrams, question text, labels, body map | CC BY-NC-SA 4.0 | Hand Nerves 3D project |
| Cell Ontology, Gene Ontology | CC BY 4.0 | OBO Foundry, Gene Ontology Consortium |
| three.js, Cornerstone3D | MIT | see `vendor/*/LICENSE` |

Changes made: models simplified, recoloured and annotated; scans cropped, downsampled and relabelled; textures removed. Share-alike material (CC BY-SA, CC BY-NC-SA) stays under its licence when redistributed. The upstream licence terms listed here come from the project's manifests and were not re-checked against the source sites.

## Privacy

Anonymous usage counts (page views; quiz started, answered right or wrong, finished with a given score, shared, signup opened and submitted) go to GoatCounter (kadin.goatcounter.com). Per [GoatCounter's privacy page](https://www.goatcounter.com/help/privacy) it stores nothing in the browser, no cookies, and does not keep IP addresses. Email signup is hosted by Kit (kit.com): an email left in the "Get 50 more questions" form is stored by Kit on the project's behalf for the one launch email; Kit's form script keeps an anonymous id (`ckid`) and a "subscribed" flag in localStorage, no cookies, as of a read of its runtime (`ck.5.js`) on 2026-10-19. The app itself keeps a random visitor id in localStorage and sessionStorage and sets no cookies. When run with `tools/serve.py`, a JSON copy of the events is kept in `data/events.jsonl` (gitignored). Contact: elbakkouri.kadin@gmail.com.
