# Security

## Posture: local development / teaching scaffold

**This is a starter template for learning event sourcing. It is not production-ready.**

The API has **no authentication of any kind**. There is no login, no API key, no session, no
role check — on any endpoint, read or write. Nothing in the application distinguishes the owner
of the shop from anyone else who can reach the port.

That is a deliberate slice-1 scope decision, not an oversight, and it has one hard consequence:

> **Do not expose this service to an untrusted network, and do not deploy it as-is.**

The backend therefore binds to `127.0.0.1` by default. That default is the only thing standing
between "no auth" and "anyone on the wifi can write to your event log."

No part of this repository has been security-certified, and it makes no compliance claim of any
kind. What follows is the record of an independent security review and an independent code review
of this tree — what they found, what was fixed, and what is still open. It is written down here so
that a developer cloning the template inherits the findings instead of rediscovering them.

---

## Known issues

Of the three findings below, the first two are **accepted, known, and tracked** — not unreviewed
and not merely open. The third (CI token scope) remains **open and unfixed**.
They were surfaced by an independent security review and knowingly accepted by the developer
(Andrew Wint), on the basis that this repository is a local teaching scaffold that has never been
deployed. Acceptance is scoped to that fact: it is a statement about today, not a judgment that
these are fine to ship. The remediation for both is tracked work, not a vague intention.

### 1. No authentication or authorization on any endpoint

**Disposition: accepted, known, and tracked.** Remediation is scoped and tracked in
`openspec/changes/add-auth-and-roles` — see that proposal for the actual plan (per-event-type
authorization, an actor on every append, a stricter gate on `StockCounted`).

`POST /api/events` accepts writes from anyone who can reach the port. There is no actor on the
event envelope, so the log cannot say *who* recorded a fact. `GET /api/stock` and
`GET /api/items/:id/history` are equally open and unscoped — the history response includes raw
payload fields such as supplier and lot id, so a reader gets the shop's inventory position and its
supplier relationships.

The part that matters most is specific to this design. A `StockCounted` event is an **absolute
reset**: it declares what is actually on the shelf and becomes the new baseline. Append-only
storage does not help here, because a false count is a perfectly *legal* append. An unauthenticated
write can therefore silently erase the shrinkage gap between the log and the shelf — which is the
one number this product exists to surface — and leave no discrepancy and no attribution behind.

Planned remediation is tracked in `openspec/changes/add-auth-and-roles`. At minimum a real
deployment needs an identity on every append and a manager-level gate on count events.

### 2. The CDK stack would publish an unauthenticated API over plaintext HTTP

**Disposition: accepted, known, and tracked.** Accepted on the same basis as issue 1 — nothing has
ever been deployed from this repository — and blocked on the same remediation, since a public ALB
in front of an unauthenticated API is one exposure, not two independent ones.

`infra/lib/bean-counter-stack.ts` creates the API service with `publicLoadBalancer: true` and an
HTTP listener. There is no WAF, no rate limiting, and no authenticator in front of it — and, per
issue 1, no authentication behind it either. On deploy, the open write endpoint and the open read
endpoints become internet-reachable in the clear.

**Nothing has been deployed.** No `cdk deploy` and no `cdk bootstrap` has ever been run against
any account from this repository; `cdk synth` is the only command anyone has executed.

The `AcknowledgeNotProductionReady` `CfnParameter` in the stack — which forces a deployer to type
an acknowledgement string — is a **typo-guard, not a security control**. It stops an accidental
deploy. It does not make a deployed stack safe, and satisfying it is not a review.

The rest of the stack was reviewed and cleared: RDS is in `PRIVATE_ISOLATED` subnets with
`publiclyAccessible: false` and storage encryption, the credential comes from Secrets Manager,
ingress is security-group-to-security-group rather than a CIDR, and the S3 bucket is fully private
behind CloudFront OAC. The public ALB is the exposure.

### 3. CI grants no explicit permissions scope

**Disposition: open, unfixed.** A related bug in the same workflow — the test suite could not
connect to its database at all — has been fixed (`DATABASE_URL_TEST` is now set explicitly); that
is a separate defect from the one below, and fixing it did not touch permissions scoping or
`npm ci`.

`.github/workflows/ci.yml` has no `permissions:` block, so `GITHUB_TOKEN` inherits the repository
default — which in many organizations is write-all — on a workflow triggered by `pull_request`,
which executes package lifecycle scripts from the branch under test. `actions/checkout@v4` leaves
`persist-credentials: true`.

The same workflow uses `npm install` rather than `npm ci`, so the committed lockfiles are not
honored and a dependency can resolve to a version nobody reviewed.

Blast radius is bounded today by the fact that the workflow references no repository secrets. Add
an explicit least-privilege `permissions:` block (`contents: read` is enough for this workflow) and
switch to `npm ci` before this repo grows anything worth stealing.

---

## Fixed, with the lesson

These were found and remediated. They are kept here because the lesson in each one applies to
anybody extending the template.

### Vendoring a directory can carry credentials that `.gitignore` would have stopped

`.claude/skills/baton/` is a vendored copy of an external skill. When you vendor anything — a
skill, a template, an example app — **exclude `.env` explicitly**:

```bash
rsync -a --exclude '.git' --exclude '.env' <source>/ <dest>/
```

A copy that is safe for source control is not automatically safe as a filesystem copy: the thing
protecting you (`.gitignore`) is consulted by `git`, and **not** by `rsync` or `cp -r`. The same
applies to container images — see the `.env` build-context entry below, where the repo root is the
Docker build context and `.gitignore` again does not apply.

Treat any credential that has ever sat in a `.env` as rotatable.

### The server bound all interfaces while three documents said localhost-only

`serve()` was called with no hostname, so Node listened on `::` — every interface, including the
shop LAN. Meanwhile `backend/README.md`, the route comment, and the startup log all asserted
localhost. The single control that the entire no-auth posture depended on existed in prose and in
no code.

Now `backend/src/index.ts` defaults `hostname` to `127.0.0.1` via a `HOST` environment variable,
and the startup line prints the address actually bound rather than an assumption about it.

`backend/Dockerfile` sets `HOST=0.0.0.0` **deliberately**: inside a container the process must
listen on the container's interface, and the boundary there is the published port and the security
group, not the bind address. **Do not "fix" that back** — and equally, do not copy it into a local
`.env`.

**Lesson:** a security control that only exists in a sentence is not a control. If a document
claims a boundary, something executable has to enforce it.

### `.env` was staged into the container image build context

The CDK image asset uses the **repository root** as the Docker build context
(`ecs.ContainerImage.fromAsset(REPO_ROOT, { file: 'backend/Dockerfile' })`). The root
`.dockerignore` excluded `infra/cdk.out`, `.claude`, and `.agents` — but not `.env`. A real `.env`
was confirmed inside a staged asset bundle, meaning a `cdk deploy` would have baked local database
credentials into the container image.

`.dockerignore` now excludes `.env`, `**/.env`, `*.pem`, and `*.key`. `.env.example` is
deliberately still stageable; it holds placeholders only.

**Lesson:** `.gitignore` and `.dockerignore` are different files with different readers. An
untracked secret is still a *present* file, and anything that stages a directory will pick it up.

### An unbounded integer quantity could permanently brick the append-only log

`z.number().int()` is `Number.isInteger` with no upper bound, so `quantity: 1e19` passed validation
and was **committed** to the append-only log. It then overflowed `(payload ->> 'quantity')::bigint`
in the `item_stock` materialized view. From that moment the read model could never refresh again
and every subsequent write failed with it — and because `events` is append-only, there was no
`DELETE` that could undo it. Chained with the unauthenticated write endpoint, one `curl` from any
device on the shop wifi could have destroyed the system permanently.

Bounded now at **both** boundaries: `MAX_QUANTITY = Number.MAX_SAFE_INTEGER` in
`backend/src/events/schema.ts`, and `CHECK` constraints in
`backend/migrations/003_quantity_bounds.sql` that compare in `numeric` so the check itself cannot
overflow.

Note the consequence, because it changes what "fixed" means: **a database that was already poisoned
cannot be migrated.** Migration 003 will fail on the existing bad row, and no correcting event can
repair it. Recovery is recreating the database from a clean log.

**Lesson:** in an append-only system, validation is not a convenience — it is the last moment at
which a mistake is still reversible. Validate at the boundary *and* at the storage layer, and pick
bounds that survive every representation the value passes through (JSON, JavaScript number, SQL
type).

### A CSV export was vulnerable to spreadsheet formula injection

`backend/src/export-readmodel.ts` quoted its output correctly for CSV *parsing* but did nothing
about the *spreadsheet* sink. An item name of `=cmd|'/c calc'!A1` — writable through the
unauthenticated endpoint — would execute when the shop owner opened the export in Excel or
LibreOffice. Separately, the default export path wrote a `.csv` into `analytics/data/`, where
`.gitignore` ignored only `*.parquet`, so a `git add .` would have committed real shop data.

Nothing read the exporter; the canonical export path is `analytics/scripts/export.py` producing
Parquet. It was **deleted rather than hardened**, and `analytics/data/*.csv` was added to
`.gitignore` for good measure. No CSV writer remains in the backend.

**Lesson:** the cheapest fix for a vulnerable code path is often deleting it, if nothing depends on
it. If you add a CSV export back, escape leading `=`, `+`, `-`, `@`, tab, and carriage return, or
use an allow-list.

---

## Reporting a vulnerability

This is a template repository, not a hosted service. There is no deployment to compromise and no
user data at risk — but the template gets copied, so a flaw here propagates.

Please open an issue in this repository. If the finding is sensitive enough that a public issue is
the wrong venue, open a minimal issue saying so and asking for a private channel, without the
details.

This is a side project with no on-call rotation and **no response-time commitment**. Please do not
rely on it as if it had one.

---

## Before you deploy this anywhere

Every item below is unfinished work, not a hardening nicety.

- [ ] **Add authentication and authorization.** An identity on every append, written into the event
      envelope, and a stricter gate on `StockCounted` than on movement events. See
      `openspec/changes/add-auth-and-roles`.
- [ ] **Put TLS in front of it.** The current ALB listener is plaintext HTTP.
- [ ] **Review the ALB exposure.** `publicLoadBalancer: true` with no WAF and no rate limiting
      publishes the API to the internet. The acknowledgement parameter is not a review.
- [ ] **Scope CI permissions.** Add a least-privilege `permissions:` block and switch `npm install`
      to `npm ci`.
- [ ] **Rotate any credential that has ever been in a `.env`** — including the placeholders in
      `.env.example`, which must never be reused for a deployed environment.
- [ ] **Confirm the bind address.** `HOST=0.0.0.0` is correct inside a container behind a security
      group and wrong almost everywhere else.
