# CommunityHunts as a platform — what would make the next tenant cheap

**To:** whoever owns the CommunityHunts API
**From:** the first external integrator to build a full consumer against it
**Basis:** a complete integration built 2026-07-30 against a live Partner key. Everything below is
something that actually cost time, not something that might.

The API is in good shape — `owner`, the `huntType` filter, `view=summary`, strict param validation
and ETags all landed and all work, and the reference docs have since been filled in with the real
payloads and the call-queue semantics. This note is about a different question: **what did this
integration need a human conversation to resolve, and how much of that repeats for tenant #2?**

Roughly everything. Almost none of the time went into HTTP. It went into questions the API could
have answered itself.

---

## The core problem: the tenant boundary is invisible

A key returns 328 hunts across 43 owners. Nothing in any response says which community that is, who
the streamer is, or which of those 43 owners is the tenant rather than a member.

So the integration needed a human to say: *the streamer is Bean, their hunts are tagged
`streamer`/`vip`/`affiliate`, and `solo`/`community` are members' own hunts.* None of that is
derivable from the API. Every tenant repeats it, and every integrator gets it wrong at least once
first — this one initially built the whole thing around `community`, which turned out to be
78 hunts across 23 different member owners.

That single missing fact is the whole onboarding cost.

---

## P0 — `GET /me`

The highest-leverage endpoint you don't have. It turns a conversation into a request.

```json
{
  "key": { "tier": "partner", "scopes": ["read"], "rateLimit": { "limit": 300, "windowSeconds": 60 } },
  "community": { "slug": "bean", "name": "Bean" },
  "streamer": { "id": "usr_WCBzj_-PK9yoYHODhMeTVa", "name": "Bean" },
  "houseHuntTypes": ["streamer", "vip", "affiliate"],
  "houseOwnerIds": { "streamer": "usr_…", "vip": "usr_…", "affiliate": "usr_…" },
  "huntTypeLabels": { "streamer": "Mod", "vip": "VIP", "affiliate": "Affiliate" }
}
```

Most of this already exists at request time and needs no new storage: the key resolves the tenant
and its tier, the tenant row carries the host, and every `usr_` value here is minted by the function
that already mints `owner.id`. Only `houseHuntTypes` and `huntTypeLabels` are genuinely new — and
they are per-tenant *policy*, so they want a settable field, not a constant in the codebase.

Four of those fields deserve argument, because they are the ones carrying the tribal knowledge:

**`streamer`** — today the tenant's own user id has to be pasted into a config file by hand. It is
the one value an integrator cannot discover, and it is the one value the key already implies. Mint
it with the same function that mints `owner.id`, so `?ownerId=` accepts it directly.

**`houseOwnerIds`** — the trap hiding inside the field above it. **`streamer.id` does not reach the
house hunts.** The shared Mod / VIP / Affiliate runs are not
owned by the streamer's user id at all; each is owned by its own synthetic key, so
`?ownerId=<streamer.id>` returns the streamer's *personal* solo and community hunts and nothing
else. Those synthetic owners are perfectly stable and perfectly usable — they just cannot be
guessed. Return them and the ownerId filter becomes usable for the house feed; omit them and
`houseHuntTypes` is the only way in.

**`houseHuntTypes`** — which hunt types belong to the tenant rather than their members. Do not
hardcode this in consumers, and do not hardcode it in the API either: it is per-tenant policy.
Bean's house hunts are `streamer`/`vip`/`affiliate`; another tenant may well run their house hunts
as `community` and never use `affiliate` at all. Serving it per key means a consumer written for
Bean works unmodified for tenant #2.

**`huntTypeLabels`** — Bean calls a `streamer` hunt a **Mod hunt**. Rendering the API's own word
would put the wrong noun on the page. Right now every consumer maintains a private mapping file
that drifts; served per tenant, everyone gets the right vocabulary for free.

**What deliberately is not here: `defaultCurrency` and `timezone`.** An earlier draft of this
payload carried both. Neither is tenant-level data — currency is a per-hunt field, and this feed
mixes USD, CAD and ARS inside one community. A tenant-level default would be *invented*, and the
one thing a consumer would do with it is pick a formatter, which is exactly how a 2,002,679 ARS
hunt gets rendered as dollars. Better absent than fabricated. If a display default is genuinely
wanted later, add it as a real per-tenant setting a host can set — don't derive it.

---

## P0 — A sandbox tenant, or seeded demo data

For most of this integration, `vip`, `affiliate` and `streamer` all returned **zero hunts**. The
consumer was complete and correct and rendered nothing, and there was no way to tell that apart from
a bug. Bean's first affiliate hunt appeared partway through the session and only then could anything
be verified.

That is the normal state for a new tenant: the integration gets built *before* the streamer has run
a hunt. Every one of them will build blind unless you give them data.

Prefer a **real read-only demo community**, reachable with any valid key, over a `?demo=true`
parameter. A flag has to be allowed on every endpoint's parameter allowlist and forks the code path
behind tenant resolution, so the thing an integrator develops against is not quite the thing they
ship against — which is the specific failure this section exists to prevent. A seeded tenant
exercises the identical path a paying one will, and it can be filled through the import endpoint
that already exists rather than through a second synthetic serializer.

Either way it needs to cover the states a real feed won't have on day one:

- a live hunt with zero bonuses opened (the state the page is in the moment it goes on stream)
- a live hunt mid-flight, with `calls` still `pending`
- a completed hunt including a `win: 0` bonus
- one hunt per hunt type, including the ones this tenant has never run
- a non-USD hunt, since currency is per hunt

That last one matters more than it looks. This feed mixes USD, CAD and ARS, and a consumer that only
ever sees USD in development ships a page that renders a 2,002,679 ARS hunt as dollars.

---

## P1 — Never answer "misconfigured" with an empty success

`ownerId=usr_nope` returns `200` with `{"data":[],"total":0}`. `huntType=bogus` correctly returns
`400`. The inconsistency is worth closing, but the multi-tenant version of this is sharper:

**A new tenant's correct-but-empty state and their misconfigured state look identical.** For most of
this integration the response to a correct query was an empty array — exactly what a typo'd owner id
also returns. There was no way to distinguish "configured right, no data yet" from "configured
wrong" without asking a human.

Validate the *shape* and `400` on a malformed one. `owner.id` is an opaque minted identifier with a
fixed prefix and length, so `usr_nope` is rejectable on sight without a lookup — and a typo is what
this actually was. Do **not** `404` a well-formed id that matches nothing: an owner with no hunts
yet is a legitimate state, and turning it into an error just moves the ambiguity somewhere worse.
Shape-check what can be shape-checked, and empty starts meaning empty.

---

## P1 — Give every user reference an id, not just `owner`

`owner` is `{id, name}`. But `equity[].name` and `calls[].user` are bare display strings with no id,
so the same person is identified two different ways in one payload and only one of them is stable.

```json
"equity": [{ "name": "Zemyt", "amount": 115000 }],
"calls":  [{ "slot": "Le Viking", "user": "Zemyt", "status": "in", "at": null }]
```

Two consequences. A consumer cannot reliably join a backer to a user, or to their own records, so a
rename silently breaks the association. And any consumer with a privacy obligation — this one masks
handles wherever a name sits beside a money figure, and both of these do — needs a stable key to
keep a masked identity consistent across periods. A display name cannot do that job.

Matching `owner`'s shape would close it: `{ "user": {"id": "usr_...", "name": "Zemyt"}, "amount": 115000 }`.

**With one thing said out loud: `id` will often be `null`, and that is not a bug.** A call is typed
as free text by whoever entered it, and an equity row only carries an identity once someone has
actually been linked to it — so a large share of rows genuinely have no id to return, and the API
must not invent one. Ship it nullable and document `null` as *unlinked row*. Silence here is worse
than the current state: a consumer that assumes the join is total will quietly drop every backer it
can't resolve, and the number it shows will simply be too small with no error anywhere.

Two rules it should follow: mint the id with the same function as `owner.id` so the two join, and
mask it the same way — a member in anonymous mode keeps a stable id and loses their name, exactly
as `owner` already does.

---

## P1 — State the enum evolution policy

`huntType` went from three values to five mid-integration. `affiliate` and `streamer` appeared with
no notice. A consumer strict-parsing that field — which is the responsible default, and what this
one does — starts throwing on live data the moment you add a value.

Two lines of docs fix it: **new enum values are additive and may appear at any time; consumers must
tolerate unknown values.** Then say what a consumer should do with one. Pair it with a changelog —
even a dated markdown page — because right now the only way to notice a change is to diff live
responses, which is how these two were found.

Say the asymmetry out loud in the same breath, because it looks like an inconsistency and isn't:
an unknown `huntType` **filter** is correctly a `400` — a typo'd filter must never quietly return
the wrong board — while an unknown `huntType` **in a response** must be tolerated. Undocumented,
that reads as a bug someone will eventually "fix" in the wrong direction.

This is the cheapest item on the list: no code, no endpoint, no migration. It is also the one whose
absence breaks a *shipped, working* consumer rather than merely slowing a new one down.

---

## P1 — Publish an OpenAPI spec

`GET /api/public/v1/openapi.json` currently 404s.

**The original reason this was filed has since been fixed** — the published reference now carries
real `bonuses`, `calls` and `equity` payloads, and documents the call queue properly, including
that `calls[]` is the only source of planned-versus-opened progress and that `bonusCount` is not
the count of opened calls. That closed the gap that forced these shapes to be derived by hitting
the live API and reading responses. Prose is no longer the problem, so this drops out of P0.

What a spec still buys, which good prose does not:

- **Generated types and a generated client on day one.** Hand-transcribing a documented shape is
  the second-cheapest way to encode a typo, and every tenant pays it independently.
- **One declared place where a shape changes.** Docs and behaviour drift silently; a spec in the
  repo drifts loudly, next to the handler that broke it — and it pairs with the changelog above.

If a hand-written spec is too much, generate it from the route handlers. An imperfect generated
spec beats accurate prose, because it can be diffed.

---

## P2 — Webhooks, per tenant

Still not built; `/webhooks`, `/events` and `/subscriptions` all 404. The full case was in the
earlier note, and it is weaker now than when that note was written: the per-hunt change stream
already covers the case most webhook requests are actually about — following a live hunt without
polling it. (Worth stating in the docs that it is a server-to-server channel: a browser
`EventSource` cannot send an `Authorization` header, so the key would have to travel in a query
string, where it lands in access logs and `Referer`.)

**The gap the stream does not close is discovery.** It is subscribed per hunt id, so a consumer
still has to poll the list endpoint to notice a hunt that did not exist yet — which on a hunt-night
feed is the one event with a hard deadline. A tenant-level `hunt.created` signal is a much smaller
ask than a webhook platform and removes the last required poll. Build that first, and let real
demand decide whether full webhooks follow.

If they do: the multi-tenant angle is that registration belongs in the tenant dashboard next to the
API key, with a visible delivery log. Support burden on webhooks is almost entirely "did it fire?",
and a log answers that without anyone opening a ticket.

A thin payload keeps your side simple — no state, so ordering and duplicates are both harmless and
at-least-once delivery is sufficient:

```json
{ "event": "hunt.bonus_recorded", "huntId": "...", "occurredAt": 1720000000000 }
```

---

## P2 — A self-serve setup page

Everything above lands in one screen in the tenant dashboard: community id, streamer user id, key
and tier, the rate limit, a copy-pasteable authenticated `curl`, a "test this key" button, and the
webhook registration. That page is what makes tenant #2 not require you at all.

Note the dependency: it is **mostly `/me` rendered in HTML**. Build `/me` first and this becomes a
thin page over an endpoint that already exists; build it first and the same facts get assembled
twice, in two places, and drift.

---

## Summary

In build order — cheapest and most load-bearing first, not strictly by priority label.

| | Ask | Why it repeats per tenant |
| --- | --- | --- |
| **P1** | Documented enum evolution policy + changelog | `huntType` grew 3→5 mid-integration, unannounced. No code; breaks *shipped* consumers |
| **P0** | `GET /me` with community, streamer, `houseOwnerIds`, `houseHuntTypes`, labels | Replaces the one conversation every tenant currently needs |
| **P1** | `400` on malformed identifiers | Otherwise misconfigured and empty are indistinguishable |
| **P1** | Nullable stable ids on `equity[]` and `calls[]` users | Joins and masking both need a key that survives a rename |
| **P0** | Sandbox or demo data covering every type and state | New tenants integrate before their first hunt exists |
| **P1** | Publish an OpenAPI spec | Generated types + one declared place a shape changes. Was P0 until the docs landed |
| **P2** | Tenant-level `hunt.created` event | The one thing the per-hunt stream can't do: notice a hunt that didn't exist yet |
| **P2** | Self-serve setup page | Turns onboarding into a URL — mostly a rendering of `/me` |
| **P2** | Per-tenant webhook registration with a delivery log | Only if real demand outlives the change stream |

The through-line: **every fact an integrator currently has to be told is a fact the API already
knows.** `/me` alone removes most of them.
