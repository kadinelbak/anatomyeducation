# Live mode data sources

Written by workstream F on 2026-10-23 from `/mnt/project-files/reports/live-mode-datasets.md`.
Status of each source is stated plainly: PACKED, or NOT PACKED with the reason.

## 1. NLM Visible Human male CT: PACKED

- Licence: public domain (NLM Terms and Conditions, 2019). Credit line: **Courtesy of the U.S. National Library of Medicine**.
  Redistributors must say their copy may not reflect NLM's current data and must not imply NLM endorsement.
- Obtained from the NCI Imaging Data Commons collection `nlm_visible_human_project` (public bucket `s3://idc-open-data`, anonymous HTTPS).
  `data.lhncbc.nlm.nih.gov` is blocked by the session proxy (403), IDC's S3 bucket is not.
- Series used (VHP-M CT, 512 x 512, 0.9375 mm in plane, 1 mm slices, DICOM):
  - `1.3.6.1.4.1.5962.1.3.32.4.1672334394.26545`, 844 slices, head to pelvis, bucket folder `f3a311eb-3abb-4b22-a28d-36ede7ddf127`
  - `1.3.6.1.4.1.5962.1.3.34.3.1672334394.26545`, 809 slices, pelvis to shins, bucket folder `aa81356d-32f2-4b71-ad81-c1defa3175ca`
- Packed with `tools/live/import_visible_human.py` (slab indices, boxes and the per-slice rule are in its `REGIONS` table):

| id | slab (series index) | dims (voxels) | voxel mm | bytes | notes |
|---|---|---|---|---|---|
| `vh-forearm` | head-pelvis 0..209, right arm | 145 x 150 x 105 | 1.9 x 1.9 x 2 | 397,667 | right hand and forearm; the arm lies beside the trunk, so only components not touching the box's medial edge are kept; the arm drifts across the box so the volume is sparse |
| `vh-thigh` | pelvis-legs 500..699, right thigh | 113 x 136 x 100 | 1.9 x 1.9 x 2 | 1,308,413 | femoral shaft, mid thigh; one thigh kept per slice |
| `vh-leg` | pelvis-legs 0..379, right leg | 96 x 109 x 190 | 1.9 x 1.9 x 2 | 886,189 | knee to distal shin; the dense blocks resting above the shins are dropped |
| `vh-head-neck` | head-pelvis 590..843 | 100 x 108 x 127 | 2.1 x 2.1 x 2 | 908,826 | vertex to lower neck |

Total 3.5 MB. Subject's right is the low-x half of the DICOM image (standard LPS, image left is patient right).
Nothing was verified against anatomy beyond viewing slices; the forearm slab ends distally in the hand and proximally in the mid forearm to elbow region.

Labels: TotalSegmentator v2 `total` task (`--fast`, CPU, Apache-2.0 weights from github.com releases) where it finds a structure, with coarse
HU-threshold labels everywhere else (ids 201 bone, 202 soft tissue, 203 fat, 204 gas inside the body). What TotalSegmentator actually found:
`vh-head-neck` brain, skull, spinal cord, vertebrae C1-C6, clavicle fragment; `vh-thigh` right femur; `vh-leg` right femur (distal part);
`vh-forearm` nothing (the `total` task has no forearm or hand classes, so that study is threshold labels only). Tibia, fibula, forearm bones and
thigh muscles need other TotalSegmentator tasks (`appendicular_bones`, `thigh_shoulder_muscles`) whose licence terms were not checked.
Sides: TotalSegmentator guesses left or right from a single limb; the importer relabels them right because the crops are the subject's right.

Reproduce (the `--labels threshold` default needs no GPU stack; `--labels totalseg` needs `pip install TotalSegmentator`, torch included, about 7 GB of
Python packages on Linux because of the CUDA wheels, and about 1 minute per slab on 4 CPU cores):

    python3 tools/live/import_visible_human.py --raw $SCRATCH/vh_raw --work $SCRATCH/vh_work --out-root assets/volumes --labels totalseg
    python3 tools/live/import_visible_human.py --selftest

Download is about 0.9 GB of DICOM (two series), deleted after packing unless `--keep-raw`. Needs numpy, scipy, nibabel, pydicom, requests.
`tools/pack_study.py` is invoked for the packing (CT mode, no `--max-dim`, since the script resamples itself).
`assets/volumes/index.json` is not edited by this script; the integrator adds entries (ids above, `region`: forearm, thigh, leg, head).

## 2. Real ultrasound reference stills: NOT PACKED (blocked)

`data.mendeley.com` answers 403 to the session proxy, so no frames were downloaded. `tools/live/import_usframes.py` is written and
self-tested on synthetic images; it writes `assets/usframes/carotid-ref/` and `assets/usframes/marzola-ref/` in the format of
`docs/live/frame-format.md` (at most 12 frames, 320 px wide greyscale JPEG, plus `credit` and `originalFiles` in `stack.json`).

| Dataset | Licence | Credit | Segment, frac |
|---|---|---|---|
| Carotid, https://data.mendeley.com/datasets/486dmdpzd7 | CC BY 4.0 | authors as on the dataset page (not machine-verified here; fill in before shipping) | neck, right, 0.3-0.6 |
| Marzola, https://data.mendeley.com/datasets/3jykz7wz8d/1 | CC BY 4.0 | Marzola F, van Alfen N, Doorduin J, Meiburger KM, Mendeley Data (citation recalled from memory, check against the page) | upper_arm (biceps), right, 0.35-0.65; run again with `--pattern tibialis --segment leg --id marzola-tibialis-ref` for the leg |

Reproduce on a machine with access: download and unzip both datasets, then

    python3 tools/live/import_usframes.py --dataset carotid --src DIR_CAROTID
    python3 tools/live/import_usframes.py --dataset marzola --src DIR_MARZOLA --pattern biceps

(`--download DIR` tries the Mendeley public API directly.) Frames with `mask` or `label` in the path are skipped.

## 3. Reference X-rays: NOT PACKED (blocked)

`figshare.com`, `api.figshare.com` and `nihcc.app.box.com` answer 403 to the session proxy; the AWS `nih-chest-xrays` bucket denies anonymous
access. `tools/live/import_xray_refs.py` is written and self-tested on a synthetic archive. It picks the first non-fracture, hardware-free,
single-scan FracAtlas image per region (hand, leg, hip, shoulder) from `dataset.csv`, takes a chest image you pass with `--chest`, downsizes to
512 px and writes `assets/xrays/<region>.jpg` plus `assets/xrays/index.json` (`region, file, source, licence, credit`).

    python3 tools/live/import_xray_refs.py --fracatlas FracAtlas.zip --chest 00000013_001.png
    # or --download DIR to fetch FracAtlas from figshare 22363012 (338 MB)

| Dataset | Licence | Credit |
|---|---|---|
| FracAtlas, figshare 22363012 | CC BY 4.0 | Abedeen I et al., FracAtlas, Scientific Data 10, 521 (2023) |
| NIH ChestX-ray14 | no restrictions, attribution requested | Wang X et al., ChestX-ray8, CVPR 2017; NIH Clinical Center |

## Credit strings for index.html

- Visible Human CT: "Courtesy of the U.S. National Library of Medicine"
- Ultrasound and X-ray reference stills: add the lines of the table rows above once those assets exist.
