// The 10 milestone-1 questions. Every answer is a structure in assets/model/arm.glb.
// Drafted from standard anatomy references; needs clinician review before launch
// (see docs/question-review.md).
//
// answer: structure keys that count as correct (from tools/parts.py).
// layers: which layers to show when the question opens (the user can change them).
// view: "palmar" or "dorsal" starting camera.

export const QUESTIONS = [
  {
    id: "median-nerve-id",
    kind: "Identify",
    prompt: "Click the median nerve.",
    hint: "Follow it down the middle of the forearm and through the carpal tunnel.",
    answer: ["median_nerve"],
    layers: { bone: true, tendon: true, nerve: true },
    view: "palmar",
    explain:
      "The median nerve runs down the middle of the forearm between flexor digitorum superficialis and profundus, then passes through the carpal tunnel deep to the flexor retinaculum.",
  },
  {
    id: "fcu-id",
    kind: "Identify",
    prompt: "Click the muscle that runs along the ulnar border of the front of the forearm and inserts on the pisiform.",
    answer: ["flexor_carpi_ulnaris"],
    layers: { bone: true, muscle: true, tendon: true },
    view: "palmar",
    explain:
      "Flexor carpi ulnaris flexes and adducts the wrist and is supplied by the ulnar nerve. At the wrist its tendon is a landmark: the ulnar nerve and artery lie just lateral to it.",
  },
  {
    id: "carpal-tunnel-apb",
    kind: "Clinical",
    prompt:
      "A 52-year-old with long-standing carpal tunnel syndrome has a flattened thenar eminence and cannot lift her thumb straight up off the palm. Click the muscle that performs this movement.",
    answer: ["abductor_pollicis_brevis"],
    layers: { bone: true, muscle: true, tendon: true },
    view: "palmar",
    explain:
      "Abductor pollicis brevis does palmar abduction of the thumb and is supplied by the recurrent (motor) branch of the median nerve, so it is the classic muscle to test and to see waste in carpal tunnel syndrome.",
  },
  {
    id: "ulnar-nerve-id",
    kind: "Identify",
    prompt: "Click the ulnar nerve.",
    hint: "It passes behind the medial epicondyle and enters the hand through Guyon's canal.",
    answer: ["ulnar_nerve", "ulnar_deep_branch"],
    layers: { bone: true, tendon: true, nerve: true },
    view: "palmar",
    explain:
      "The ulnar nerve passes behind the medial epicondyle (the 'funny bone'), runs under flexor carpi ulnaris, and enters the hand through Guyon's canal, superficial to the flexor retinaculum, not through the carpal tunnel.",
  },
  {
    id: "froment-adductor",
    kind: "Clinical",
    prompt:
      "A long-distance cyclist has numbness of the little finger. When asked to grip paper between the thumb and the side of the index finger, the thumb tip flexes (Froment's sign). Click the weak muscle.",
    answer: ["adductor_pollicis"],
    layers: { bone: true, muscle: true, tendon: true },
    view: "palmar",
    explain:
      "Adductor pollicis is supplied by the deep branch of the ulnar nerve, which handlebar pressure can compress at Guyon's canal. The patient substitutes flexor pollicis longus (median nerve), which flexes the thumb tip.",
  },
  {
    id: "fdp-id",
    kind: "Identify",
    prompt: "Click the muscle that flexes the distal interphalangeal joints of the fingers.",
    answer: ["flexor_digitorum_profundus"],
    layers: { bone: true, muscle: true, tendon: true },
    view: "palmar",
    explain:
      "Flexor digitorum profundus inserts on the distal phalanges. It has a split supply: the anterior interosseous nerve (median) for the index and middle fingers, the ulnar nerve for the ring and little fingers.",
  },
  {
    id: "ain-fpl",
    kind: "Clinical",
    prompt:
      "After a supracondylar fracture, a child cannot make an 'OK' sign: the thumb and index fingertips stay straight and touch pad to pad. Sensation is normal. Click the muscle that flexes the thumb's interphalangeal joint.",
    answer: ["flexor_pollicis_longus"],
    layers: { bone: true, muscle: true, tendon: true },
    view: "palmar",
    explain:
      "This is anterior interosseous nerve palsy, a purely motor branch of the median nerve. It supplies flexor pollicis longus, the lateral half of flexor digitorum profundus and pronator quadratus, so sensation is spared.",
  },
  {
    id: "humerus-superficial-radial",
    kind: "Clinical",
    prompt:
      "A midshaft humerus fracture leaves a patient with wrist drop and numbness over the back of the first web space. Click the nerve branch that carries sensation from that skin through the forearm.",
    answer: ["radial_superficial_branch"],
    layers: { bone: true, muscle: true, nerve: true },
    view: "palmar",
    explain:
      "The radial nerve is injured in the spiral groove of the humerus. Its superficial branch runs under brachioradialis and crosses to the back of the hand to supply the skin of the first web space; wrist drop comes from losing the wrist extensors.",
  },
  {
    id: "pin-syndrome",
    kind: "Clinical",
    prompt:
      "A patient cannot extend the fingers at the knuckles but can still extend the wrist, which drifts toward the thumb side. Sensation is normal. Click the nerve compressed as it passes through supinator.",
    answer: ["posterior_interosseous_nerve"],
    layers: { bone: true, muscle: true, nerve: true },
    view: "dorsal",
    explain:
      "The posterior interosseous nerve (deep radial) pierces supinator and supplies the finger extensors and extensor carpi ulnaris. Extensor carpi radialis longus is supplied above the split, so the wrist still extends but deviates radially. The branch is purely motor.",
  },
  {
    id: "dorsal-interossei",
    kind: "Clinical",
    prompt:
      "A patient with an ulnar nerve lesion cannot spread the index and ring fingers away from the middle finger. Click the muscles that perform this movement.",
    answer: ["dorsal_interossei"],
    layers: { bone: true, muscle: true },
    view: "dorsal",
    explain:
      "The dorsal interossei abduct the fingers away from the middle finger (DAB); the palmar interossei adduct them (PAD). Both groups are supplied by the deep branch of the ulnar nerve.",
  },
];
