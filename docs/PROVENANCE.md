# Frozen authorities and interpretation

Authority order: upstream SOURCE requirements interpreted in R3; R3 local behavior; Stage03 architecture; Stage04 test interfaces. These inputs were provided as frozen archives and were not replaced from a live upstream branch.

| Authority | SHA-256 |
|---|---|
| FEEDME_STAGE02D_CORRECTED_LOGIC_R3.zip | `7a22c45a4ab7ee8d77935ec4507938df4011d852025389fb17e45f92246333eb` |
| FEEDME_STAGE03_ARCHITECTURE_R1.zip | `f2e2110d09f6acc33de5ca546e768d009b1c835bb51d1363464ccf7c670bfd46` |
| FEEDME_STAGE04_TEST_SPECIFICATION_R1.zip | `eabe7decd177109e6c2914e1c12bf692086b559f803a1a79fbdb462a8c407adb` |

The supplied integrity verifier confirmed Stage04's embedded R3/Stage03 and Stage03's embedded R3 are byte-identical to the originals. The build-pack ZIP hash is `11d61e68630a2b7bd62908b75bd4f4e922d9c5343c7e58d2011705260ed49ace`.

Upstream: <https://github.com/feedmepos/se-take-home-assignment>, frozen commit `2652e3c9c1d8446790e2961a113c391b52d5abf0`, Apache-2.0. The project implementation and executable tests were authored independently for this delivery. The two authority-provided JSON fixtures in `tests/fixtures/` are unchanged. `valid-r05.jsonl` is an independently written checker test input, authored before production output existed; it is not execution evidence or a trusted generated result file.

The controller uses the exact Stage04 API. Canonical snapshots use a worker-ID-to-order-ID `processing` object, decimal `timeNs`, required identity lists and detached `attempts`/`counts` metadata. Closing retains a detached terminal observation while clearing live state; further calls emit nothing. These choices preserve frozen behavior and require no design exception.

`tests/oracles.test.js` compares seven R05 checkpoints and ten AT-19 checkpoints to the original fixtures. `tests/verify-demo.js` independently checks freshly emitted R05 logs: it compares the fixed semantic trace and reconstructs checkpoint states without importing the controller. Its replay checks emitted identities and attempt linkage; it does not generate expected schedules. Removal/interruption at t=2 accepts either inner order.

The original upstream scripts could pass with stale output and placeholders. The new scripts execute tests, parse/import sources, remove stale output, run the real demo, and apply the external oracle. Six isolated fault rehearsals challenge that pipeline; the final delivery evidence records their actual outcomes.
