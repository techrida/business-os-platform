# Unit QA runner (round 5)

Browser checks of the round-4 hand guides and the FG-Q2 capture, built on the manual-run library (`../lib`).
Development and test tooling only; it adds no app code. Credentials are read in code from `PERSONAS_FILE` and
never printed (everything written goes through the library's redactor).

```sh
export PERSONAS_FILE=<stack>/.dev/personas.json PLAYWRIGHT_FROM=<checkout>/apps/workspace/package.json
node tools/manual-run/qa/run.mjs --guides retest,r4a,r4d,r4c1,r4e,r4f,r4c2,mut   # one guide module per name
QA_ONLY=r4a:1.1,r4a:1.2 node tools/manual-run/qa/run.mjs --guides r4a            # re-run single checks
node tools/manual-run/qa/fgq2.mjs --role founder [--plan login|salesdialogs|inboxdialogs] [--only slug,slug]
node tools/manual-run/qa/report.mjs      # evidence/QA/index.html and results.md
node tools/manual-run/qa/kuu-guide.mjs   # round5/guide/QA.html: the checks left for a person
```

- Every check is independent and gets a screenshot. Status is PASS, FAIL, BLOCKED (precondition absent on the
  stack) or NOT-RUN (not scripted), each with the controls asserted (roles and names, never a guessed container).
- A read-only check that fails is re-observed once after a reload; both attempts are recorded.
- Mutating checks (`g-mut.mjs`, parts of `g-r4a.mjs`) create only records named `QA r5qa ...`.
- Personas switch through the Dev switcher (`/dev/personas`); `fgq2.mjs` signs in per role through the real sign-in.
- Output: `QA_EVIDENCE` (default `/home/crestia/bos-runtimes/round5/evidence/QA`), outside git.
