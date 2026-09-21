# Jev reviewer CI

The existing **Git bundle smoke** workflow checks every pull request and main
push on macOS ARM64 and Windows x64 with Node 24 and Pi 0.81.0.

Each platform runs:

1. `npm ci --ignore-scripts` to install the committed dependency graph.
2. `npm run check` to typecheck both permission packages, including tests.
3. `npm test` to check the bundle contract and run all behavior tests. Jev tests
   mock the Gateway evaluation SDK and the official TypeSafe HTTP `fetch`
   transport (plus provider authentication); they do not call Vercel or
   api.typesafe.ai, and they require neither an AI Gateway secret nor
   `TYPESAFE_API_KEY`.
4. `npm run build -- --check` to compare a fresh in-memory build with committed
   `index.js`. A stale artifact fails the job without overwriting it. Regenerate
   it with `npm run build` before committing source changes.
5. A real Pi Git install, load, and update at the PR head, followed by a local
   Git fixture that advances HEAD and removes installed dependencies before
   updating. Both checks use fresh temporary Pi settings directories.

The production-install checks verify that the pinned AI SDK resolves inside the
installed Git checkout, exports the evaluation API, and constructs the Jev model
without inference. They also verify that Pi loads exactly one composition entry,
host Pi APIs are not installed as production dependencies, and Safe-Allow uses
the bundled permission-system workspace. This catches dependencies that work in
development but disappear under Pi's `npm install --omit=dev` installation.

The workflow uses a writable temporary `PI_CODING_AGENT_DIR`, not a developer's
credential store. The GitHub token authenticates Git fetches only; no inference
secrets are configured. Package installation still requires npm network access.

These checks prove protocol handling, authorization behavior under synthetic
responses, and packaging compatibility. They do not measure Jev's live approval
accuracy or availability. Any live connectivity check is separate and must use
synthetic harmless evidence.
