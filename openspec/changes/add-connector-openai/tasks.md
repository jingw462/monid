# Tasks: add-connector-openai

## Connector implementation

- [x] Inspect the six hosted Monid contracts and official native Images APIs.
- [x] Add bearer-authenticated provider, long-request timeouts and USD pool.
- [x] Add shared native field mirrors and public binding constraints.
- [x] Add six fixed-model generation/edit endpoints and JSON reference mapping.
- [x] Add per-token rate card, input-derived estimates and receipt evidence.
- [x] Add size preflight and zero-billed vendor/malformed-response failures.
- [x] Document native PNG base64 and the host artifact-storage integration seam.
- [x] Register only the six new public identities in ids.lock.json.
- [x] Add minimal shared synthetic fixtures and sealed-unit integration tests.
- [x] Add one credential-gated live smoke test.

## Verification

- [x] Format/lint/typecheck the change and run its offline integration suite (35 pass).
- [x] Run the full repository offline test suite (1294 passed, 0 failed, 216 skipped).
- [x] Verify deterministic compilation, six catalog identities, pure estimate CLI and version gate.
- [x] Review calculator evaluation order, malformed PNG/Base64 responses and empty-host URLs;
      add regression cases and rerun the full offline suite on 2026-10-17.
- [x] Compare all six compiled output estimators with the current official calculator
      across 757796 valid size/quality combinations (zero differences).
- [ ] Follow up existing ids.lock.json drift separately: 78 unregistered and
      7 obsolete non-OpenAI identities in main; this port preserves existing entries.

## Follow-up requiring private infrastructure or vendor credentials

- [ ] Compare native mapping/estimates with the legacy monid-services adaptor.
- [ ] Connect/verify hosted PNG persistence, image artifacts and seven-day URLs.
- [ ] Run live vendor smoke tests and replace synthetic fixtures with sanitized recordings.
