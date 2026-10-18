## Coverage mapping

`coverage-109.json` records each check from annotation-server
`dbfc672e7c49cd8be278f0a1aa472c80195cd2b8` and the three additional checks in
the integrated baseline `766fb9234a9adeba002bd56728a5c55de6795c8c`.
The integrated source line identifies the complete original assertion block.
Each item names the current production-logic or HTTP evidence and any remaining requirement.

Run from annotation-server:

```bash
node test/coverage-109-check.mjs
npm run unit-check
npm run durability-check
npm run model-check
```

The mapping checker uses the TypeScript compiler AST. It verifies all 109 original
test names against the 112 integrated checks, verifies the ordered source lines,
and resolves each local evidence test. Its JSON report includes original source
lines, source hashes, test-name hashes and evidence paths. Evidence validation
checks references; semantic equivalence requires reviewing the referenced assertions.
Successful mapping validation does not establish full acceptance.

Statuses apply to the whole original assertion block:

- `covered`: the listed local tests or durability scripts verify its behavior
  through production functions, real local HTTP and real storage.
- `missing_configuration`: explicit real-provider or OAuth checks exist and await
  authorized configuration. `acceptance: "not_run"` records their unverified
  execution status; `assertions` identifies the required checks.
- `missing_check`: at least one assertion has no equivalent check. Existing
  partial evidence remains listed. Missing checks stay visible even when they
  would also require external configuration.

Local session issuance verifies service permissions. GitHub token exchange and
OAuth code redemption require actual GitHub authorization. Provider normalization
tests supply input directly to production pure functions. Provider integration
uses actual `JevJudge` and `LlmJudge`; negative protocol sequences await an
authorized controlled endpoint or user confirmation of the requested exception.

Cache loading tests use actual files and production rule output. The real-model
group obtains provider results from the authorized endpoint before testing cache
reuse, restart, legacy coverage and corruption. Billing evidence retains the
actual provider response and requires nonzero input and output usage. Every
judged block needs a suggestion or a degraded conclusion. Sorting needs multiple
actual suggestions. Cache files must have version 1, and repeated requests must
leave provider call counts unchanged.

The local reply merge check allocates actual UUIDs through `newId` and verifies
parent references, identity and order within one submission. The restart retry
check causes a real file write failure, removes the file obstruction, starts a
new process and retries the same request with a newly issued permit. It verifies
one persisted annotation and one operation. UTC boundary checks remain unverified
pending separate time-source authorization.
