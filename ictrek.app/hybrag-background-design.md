# V-Note / HybRAG background delegation and synchronization

Status: background authorization, incremental reads and persistent scheduling
are implemented in development source; real VOS/device acceptance is pending.
Migrations 0102–0103 persist encrypted grants,
issuance reservations and revocation outboxes. Saving enabled sync requests a
fresh VOS proof through the bridge, with no token-copy or separate Connect step.
The server retries controls and revocations after the page closes. Existing
manual synchronization remains available where background capability is absent;
known revoked grants never fall back to a broader human token.

## Required platform capability

The approved implementation uses a minimal platform-issued opaque credential,
bound to the immutable VOS subject and both installed applications. Only the
platform's issue/status/revoke operations accept it. Each app independently binds
that exact secret to its local owner, personal workspace and selected roots.
Ordinary access/refresh tokens are not persisted for unattended work. Validate
the platform extension through a real VOS upgrade before production use.

The platform baseline before this extension was insufficient for this capability:
`vos-platform-backend/src/domain/oauth2/token_service.rs` reloads the user's
effective RBAC when refreshing an ordinary token, even if its OIDC scope is
reduced. `router.rs` returns live user information for human tokens but returns an
app token as an admin identity without a user lookup. Encrypting an ordinary
refresh token does not reduce its authority. `router.rs` introspection checks
access-token signature and blacklist or refresh-token records, but does not
reload user status; its blacklist error path returns not revoked. The current
`user_router.rs` user/check uses the calling token's user ID and falls back to
its claims if the user no longer exists. Neither establishes unattended liveness
for an app-issued capability. User list is a separate RBAC-controlled operation,
not a subject-bound integration liveness API. Searches of the platform source
have not established a durable user-status event contract for this use. Do not
persist a broad refresh token or bind accounts by username.

A minimal platform addition could bind an integration grant to a human subject
and the installed app pair at consent, then expose an authenticated status check
returning only active/inactive and a monotonic grant or authorization revision.
The check must fail closed for disabled/deleted users, removed app access,
revocation, lookup errors and unknown grants; its caller cannot query arbitrary
subjects. V-Note can keep its own grant, outbox and worker. Both applications
must agree on the check's freshness and the publication fence, since a remote
check alone cannot close a concurrent revocation race.

## Proposed platform contract for review

The user approved the minimum platform extension. Development routes use
`/v1000/oauth2/integration-grant/{issue,status,revoke}`; the conceptual contract
below describes the required guarantees, not approval to deploy. The platform
component is `vos-platform-backend` (grant storage,
authentication and status operations), with any necessary user/app lifecycle
hooks and schema migration. The two apps own their separate scope and delivery
state. A concrete candidate is:

1. `POST /v1000/integration-grants` accepts a fresh, authenticated human VOS
   session and an explicit consent for the installed V-Note/HybRAG pair. The
   platform derives the subject from the session, verifies both app identities
   and current app access, and creates a random grant ID plus a high-entropy
   secret bound to that pair. It returns the secret once over a protected channel;
   it contains no VOS access token, general permission or arbitrary-user lookup.
2. `POST /v1000/integration-grants/status` authenticates the grant secret and
   the bound caller using a platform-supported app authentication mechanism.
   It derives the subject and pair from the stored grant, never from a caller
   supplied username or subject. It returns only `{active, revision}`; `active`
   requires an existing enabled human, valid grant and current access to both
   installed apps. Unknown/revoked grant, invalid caller, missing user, storage
   errors and timeouts cannot yield active. Status and lifecycle mutations need
   a documented consistent read/write ordering; a stale cache is insufficient.
3. A human-authenticated revoke operation invalidates the grant, and disabling or
   deleting the user, withdrawing app access or uninstalling either app makes
   subsequent status checks inactive. Re-enabling access must not silently
   restore a revoked grant. Grant secret rotation must not leave two unintended
   active grants after a lost response; otherwise stop and require re-consent.

Store a verifier, not the plaintext secret, on the platform. V-Note encrypts its
copy with versioned keys and clears it on local revocation. The secret alone may
only check its own status; it cannot call other platform APIs. The integration's
own capability independently limits reads and target actions to the bound
subject and selected roots. Neither app may rely on a caller-controlled subject
or a permanent app-admin token to infer consent. Exact endpoint names, app caller
authentication, consent UI, retention, key lifecycle and supported app-access
checks require implementation review against the actual platform version.

The platform status response is a point-in-time observation, not a distributed
transaction with HybRAG. If the product requires zero publication after a
revocation commits, the platform and target need a shared linearizable fence or
equivalent coordination; a short-lived signed status by itself permits a window.
Until that guarantee or an explicitly accepted window is specified and tested,
the feature cannot claim instantaneous revocation. Source unavailability prevents
new progress but cannot undo an external request already in flight.

## Protocol and recovery requirements

* Obtain explicit consent while both applications verify the same stable subject.
  Store only the restricted grant encrypted with versioned keys; rotation and
  revocation must be crash-safe. Never log tokens or note content.
* Before each new read, external model/index request and publication, check the
  grant and source authorization; errors, timeouts and malformed responses stop
  advancement. Define a bounded authorization lifetime and the behavior of
  requests already in flight. A check followed by an independent publish cannot
  by itself prove instantaneous revocation: an atomic fence or an explicitly
  accepted bounded window is required across the services.
* Persist desired control and acknowledgements transactionally. Retry idempotently
  using monotonically increasing versions, bounded backoff and a durable outbox;
  never acknowledge a version without verifying its redemption and target result.
  A newer version must not be overwritten by a delayed response.
* Persist work identity, generation and state before side effects. A timeout or
  expired lease is not evidence that an external request terminated. Retain its
  processing slot until termination can be proven, including after process restart;
  otherwise require explicit recovery. Publish only a fully indexed generation
  under the current authorization fence. Reconcile unknown outcomes without
  exposing staged content or deleting another user's data.
* Test platform disablement, grant revocation, app access removal, network
  partitions, delayed and duplicated messages, crashes at each durable boundary,
  multiple workers, real PostgreSQL and real external index/model concurrency.
  Test real VOS upgrades on both supported devices before claiming readiness.

## Implementation status

The user has authorized the minimum platform authentication extension. The local
reference checkout remains detached at `a63048db5`. Platform work is in
`/Users/czy/p/vos-integration-grant` on `codex/vos-integration-grant`, based on
`14989b1c9` from `git@github.com:ictrektech/ictrek-monorepo.git`. That version
uses versioned schema migrations. Its development API is incomplete and is not
ready for unattended operation or deployment.
Do not install or release either revision as a result of this authorization.
The manual flow now persists the accepted attempt and rejects a status for a
different generation or a target that lacks an attempt identifier. It retains
uncertain deliveries for recovery; it does not provide automatic recovery.

The development status-grant response identifies only the credential's own
subject when active. V-Note compares that subject with the authenticated owner
both at issuance and on every status check; an absent or different subject
fails closed. Issuance is connected to the settings save action and handles
uncertain results without granting source access to an unpublished credential.
The platform development branch now persists revocation in PostgreSQL and uses
verified JWT IDs consistently. Its issuance transaction serializes with proof
revocation and rejects proofs from before the storage cutover. Isolated real
PostgreSQL tests cover migration, another connection/restart, expiry and a blocked
issuance racing a revocation. All authentication instances must be upgraded
before this capability is exposed; real VOS upgrade acceptance remains pending.

Grant issuance is reserved durably and never replayed by maintenance. Returned
secrets enter a revocation outbox before local publication; a failed configuration
check leaves the secret available for retrying revocation. A lost platform
response cannot authorize source reads, and the next human consent supersedes the
previous platform grant. Revoking rows retain the encrypted credential until the
platform and target acknowledge. Disabled control snapshots may use the exact
previously registered credential even after platform revocation; that exception
cannot enable scope, import notes or read status. A durable tombstone survives
deletion of the settings row. Ordinary membership in a personal workspace is
insufficient: it must have one owner and no other members.

HybRAG stores its credential encrypted for that exact owner, subject and personal
workspace. VOS packages automatically create a separate private key in
`/data/vnote-secrets/encryption.key`, inside the existing persistent runtime
volume; login/signing and model encryption keys are unchanged. At task admission,
before and after each index batch, and immediately before atomic publication,
delegated tasks recheck both platform status and source scope/configuration and
the source content hash/title. Failures stop advancement and retain the published
copy. A boundary known to have no outstanding external request can retire the
staging attempt and release the global slot; an unknown model timeout cannot.
These checks are observations across services, not an instantaneous distributed
revocation guarantee. Local delivered controls still provide the atomic fence.

Maintenance reads a bounded set of due rows with backoff; it never scans note
bodies or starts models. Its Bun timer and Worker scheduled entry point invoke
the same business code. Uncertain model-outcome recovery and real VOS/device
acceptance remain unfinished. Private Web read liveness is described below.

## Incremental source protocol and target queue

Migration 0104 exposes restricted snapshot, changes and export-note operations
under `/api/integrations/hybrag/`. Metadata contains no bodies. Snapshots reuse
materialized notebook scopes and indexed notebook/note bookmarks; the first
change cursor stays fixed across pages. History has an identity, receipt and
prune watermark. Lost receipts, pruning and hierarchy changes rebuild snapshots.
A moved/deleted note reveals only its previously authorized ID, never its new
title or location. Only export-note reads one current scoped body. Externally
replacing a raw database requires an explicit source-identity recovery contract;
the protocol cannot detect every possible ABA restore of identical history.

Migration 0105 permanently retires grants and in-flight issuance reservations on
local user disable/delete, identity change/unlink, loss of personal ownership or
temporary sharing. Restoring those rows does not restore old authority. Ordinary
profile, title and body edits do not revoke grants.

Migration 0106 stores the manual/interval/night plan, exposed through a small
plan lookup. The default interval is 15 minutes. Night windows use an explicit
IANA zone and may cross midnight. HybRAG checks the window before admitting a new
model job; existing requests may finish later. Manual-only starts no unattended
work; the existing Sync now run still needs its page open.

HybRAG PostgreSQL 000165 / SQLite 000069 persist bookmarks and the latest desired
operation per note, without bodies. Desired versions and cursor advance in one
transaction. Only completed scans produce absence tombstones, including earlier
manual copies. Deletion switches only the owner's published pointer; physical
indexes stay hidden until separate reclamation. In-flight requests defer deletion
and retain the global gate. Unchanged hash/title needs no body or model call.
Restart resumes exact attempts; confirmed cancellation may retry, while unknown
external outcomes remain blocked.

The target loop coordinates replicas with database leases and processes bounded
pages/documents. Source settings remain authoritative. UI polls use configuration
rows and target index lookups, not recurring full-note counts. Subtree pause,
managed-KB deletion and complete device/upgrade
verification remain outstanding. Nothing has been deployed or released.

## Reading retained copies

HybRAG's ordinary authenticated HTTP path lazily requires a current human VOS
proof for V-Note private KB reads. Each request checks live enabled status and an
existing stable binding; success is reused only within that request. An old local
JWT or service token alone is insufficient. Non-interactive acting-via principals
cannot inherit this personal Web read permission.

The existing VOS bridge supplies the proof without another button. Ajax and chat
SSE attach it only to this application's same-origin API. It stays in memory,
without adding broad refresh-token storage. Verification failure hides private
reads while ordinary KB authentication stays unchanged. Ingestion has its own
background authority. Reading retained copies does not require an active sync
grant, so the active owner can still search after stopping synchronization.
Already returned chat content and client caches are not rewritten by this check.
Real upgrade and account-disable interaction acceptance remain pending.

## Root pause and processing boundaries

Migration 0107 stores selected paused roots. Pause/resume takes effect on Save;
unselecting a root stops it instead. Both retain published copies. Root pause
keeps the connection but denies current source reads, exports and manual steps.
Resume requires the new delivered configuration and a full reconciliation.
Older clients omitting the pause field retain pauses on roots still selected.
Per-note and descendant-subtree pause are not implemented yet.

Automatic desired versions wait about one minute after a recent edit. Another
title/body version refreshes the deadline; identical metadata does not. Old
snapshot notes are immediately eligible, and invalid/future source clocks wait
at most one minute. Sync now bypasses this wait. Neither waiting nor a busy
global model slot exports another body. The actual worker checks the night
window again before starting; already-started documents may finish later.

Duplicate tasks and stale pending snapshots cannot cancel or free another
worker's processing slot. An uncertain index failure records a recovery warning
immediately, including after control revocation, with only diagnostic writes
permitted. The stopped owner's page can still report that warning. It does not
automatically retry the model or release an unknown external outcome.

The small source plan also supplies the selected root's name. Empty roots and
manual-only background connections provision their private KB without scanning
bodies or invoking a model. A configured default embedding model is still
required. Renames update only KB metadata, including unchanged manual imports.
Creation and rename lock and verify the delivered control in their transaction;
late revoked requests and soft-deleted KBs cannot recreate a root this way.
Explicit managed-KB deletion/re-enablement, physical reclamation, per-note pause
and actual VOS/device acceptance remain outstanding.

## Pending delivery repair and deletion-only maintenance

For registered automatic jobs still pending after 90 seconds, HybRAG inspects
the exact task ID at most once per minute. Existing pending/active/scheduled/retry
tasks retain their queue and backoff. Confirmed missing delivery is re-enqueued
from the stored Markdown with the same ID and attempt; an archived task may be
restored only while its document is still pending. Queue errors are not evidence
of absence. Current local control, model gate, platform grant and source scope
are checked before repair. Lite mode may repair an unstarted task without a
persistent inspector. Repair does not fetch another source body or create a new
generation. Atomic worker claim arbitrates original and duplicate delivery.
Processing/finalizing or unknown external outcomes are never replayed. Older
manual runs without registered background work are outside this repair contract.

Metadata checks and removal of deleted/moved-out note copies continue at the
configured interval in Manual only and outside night hours, without body export
or models. Pausing a root freezes these checks; stopping/removing a root retains
copies. Deleted source-root reconciliation is described below; managed-KB deletion
remains pending.
Target PostgreSQL 000166 / SQLite 000070 add a deletion-only due index; wake
lookups separately probe each status's first row instead of sorting the backlog.

## Deleted source roots

A still-selected, unpaused root that was deleted or moved to another workspace
exposes an empty authorized metadata scope, without the new location/title/body.
Hierarchy fencing resets old cursors. After a complete empty scan, the target
clears published pointers through its existing deletion queue and retains the
empty private KB, original name and history. A root missing before provisioning
does not create a new KB. Manual-only and closed night windows still reconcile
this metadata. No new model work starts while the root is missing.

Pause freezes reconciliation; explicit stop/unselection retains copies. An
unknown in-flight model outcome can defer removal and keeps its global slot.
Restoring the same still-selected root revalidates ownership and scope, then
catches up under the current plan; already hidden copies may need reindexing.
Old empty-snapshot builds cannot erase a concurrently restored scope. Real VOS
upgrade/device acceptance, per-note/subtree pause, managed-KB deletion and
physical reclamation remain unfinished.
