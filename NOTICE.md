# Notices and licences

The app's code is released under the MIT licence (see `LICENSE`). The app is run as a non-commercial, free educational project. Third-party material keeps its own licence, listed below and not covered by the MIT licence. The same list is shown in the app under Credits.

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
| Stylised cell models and diagrams | CC BY-SA 4.0 | Hand Nerves 3D project |
| Cell Ontology, Gene Ontology | CC BY 4.0 | OBO Foundry, Gene Ontology Consortium |
| three.js, Cornerstone3D | MIT | see `vendor/*/LICENSE` |

Changes made: models simplified, recoloured and annotated; scans cropped, downsampled and relabelled; textures removed. Share-alike material (CC BY-SA, CC BY-NC-SA) stays under its licence when redistributed. The upstream licence terms listed here come from the project's manifests and were not re-checked against the source sites.

## Privacy

The app keeps a random visitor id in the browser and sends anonymous usage events (questions answered, scores, set choices, timing) to the project's server. No names, emails, accounts or cookies. Email signup is switched off (`signupEnabled: false` in `src/config.js`); if it is turned back on, the notice must say that emails are stored. Contact: elbakkouri.kadin@gmail.com. Stored files: `data/events.jsonl`, `data/signups.jsonl` (gitignored).
