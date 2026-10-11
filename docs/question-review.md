# Questions for clinician review

The 10 milestone-1 questions, drafted from standard anatomy references
(Gray's, Moore, Last's) without a clinician. Please check each stem, answer and
explanation before launch. Items marked **check** are the ones I'm least sure
of or that simplify deliberately.

Answers are structures in the 3D model. Nerves and arteries in the model are
schematic (BodyParts3D has none for the forearm); their courses are listed at
the end for review too.

| # | Type | Stem (short) | Answer | Explanation given | Notes |
|---|------|--------------|--------|-------------------|-------|
| 1 | Identify | Click the median nerve | Median nerve | Runs between FDS and FDP, through the carpal tunnel deep to the flexor retinaculum | Accepts any part of the trunk or its digital branches; the recurrent branch is a separate structure and is not accepted. **check**: should the recurrent branch count? |
| 2 | Identify | Muscle on the ulnar border of the anterior forearm inserting on the pisiform | Flexor carpi ulnaris | Flexes and adducts the wrist; ulnar nerve; tendon is the landmark lateral to which the ulnar nerve and artery lie | |
| 3 | Clinical | Long-standing carpal tunnel syndrome, flattened thenar eminence, cannot lift thumb straight up off the palm | Abductor pollicis brevis | Palmar abduction; recurrent branch of median; classic muscle to test | Opponens pollicis and the superficial head of FPB are also median-supplied and waste too, but the movement described (palmar abduction) points to APB. The model accepts only APB. **check**: accept opponens pollicis as well? |
| 4 | Identify | Click the ulnar nerve | Ulnar nerve (trunk or deep branch) | Behind the medial epicondyle, under FCU, through Guyon's canal superficial to the retinaculum | |
| 5 | Clinical | Cyclist, little-finger numbness, Froment's sign | Adductor pollicis | Deep branch of ulnar nerve compressed at Guyon's canal; FPL (median) substitutes | Little-finger numbness implies the superficial branch is also involved (zone 1 lesion), which is consistent with handlebar palsy. |
| 6 | Identify | Muscle that flexes the DIP joints | Flexor digitorum profundus | Inserts on distal phalanges; AIN for index and middle, ulnar for ring and little | |
| 7 | Clinical | Supracondylar fracture in a child, cannot make OK sign, sensation normal | Flexor pollicis longus | AIN palsy; purely motor; FPL, lateral FDP, pronator quadratus | The stem describes thumb IP and index DIP both failing; the question asks for the thumb muscle only. **check**: wording "touch pad to pad" for the failed OK sign. |
| 8 | Clinical | Midshaft humerus fracture, wrist drop, numb first dorsal web space | Superficial branch of radial nerve | Spiral groove injury; superficial branch under brachioradialis supplies first web space skin | The model's radial nerve trunk is cropped just below the elbow; the clickable answer is the superficial branch only. |
| 9 | Clinical | Cannot extend fingers at MCP joints, wrist extends with radial deviation, sensation normal | Posterior interosseous nerve | PIN pierces supinator; ECRL supplied above the split so wrist still extends but radially; purely motor | Some texts also list ECRB as branching before the arcade of Frohse; the explanation names only ECRL to stay safe. **check**. |
| 10 | Clinical | Ulnar lesion, cannot spread index and ring fingers away from the middle finger | Dorsal interossei | DAB/PAD; deep branch of ulnar | The model has one mesh for all four dorsal interossei. |

## Schematic nerve and artery courses to review

Placed by hand in `tools/nerves.py`, in this model's coordinates, against
its muscles and bones:

- **Median nerve**: medial to brachial artery in the arm; between the heads of
  pronator teres; between FDS and FDP; emerges lateral to the palmaris longus
  tendon just above the wrist; carpal tunnel deep to the retinaculum; four
  digital branches (thumb, index, 2nd and 3rd web spaces) and a recurrent
  motor branch curling to the thenar muscles.
- **Ulnar nerve**: behind the medial epicondyle; between the heads of FCU;
  on FDP deep to FCU; lateral to the FCU tendon at the wrist; Guyon's canal
  superficial to the retinaculum, lateral to the pisiform; superficial branch
  to the little finger and 4th web space; deep branch across the palm to
  adductor pollicis.
- **Radial nerve**: between brachialis and brachioradialis at the elbow, then
  splits: superficial branch under brachioradialis, emerging on the lateral
  side in the distal third to the back of the first web space; posterior
  interosseous nerve through supinator, around the radius, and down the
  interosseous membrane.
- **Radial artery**: from the brachial bifurcation under brachioradialis to
  the radial pulse lateral to the FCR tendon, then dorsally through the
  anatomical snuffbox and between the first two metacarpals into the deep
  palmar arch.
- **Ulnar artery**: from the bifurcation under pronator teres and FDS, down
  with the ulnar nerve to Guyon's canal, continuing as the superficial palmar
  arch across the palm.

Known simplifications: no anterior interosseous nerve or artery, no cutaneous
branches of the forearm, no brachial artery above the cubital fossa, no deep
palmar arch drawn in full, single "trunk" diameters.
