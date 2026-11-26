# Fairness and Auditability

## Goals and honest scope

| Property | Provided? | How |
|---|---|---|
| Deck generated only on the server with a CSPRNG | **Yes** | `crypto.randomInt` (OS `getrandom`) driving Fisher–Yates. `Math.random` is banned by a test. |
| The deck cannot be changed after the hand starts | **Yes, verifiable** | A salted per-card Merkle commitment is published before entropy is collected. Every revealed card carries a proof. |
| The operator cannot choose which card a given player gets | **Yes, verifiable**, if at least one honest player contributed entropy | Player entropy collected *after* the commitment permutes the deal order. |
| Opponents' mucked and undealt cards stay private | **Yes** | Salts are never published for unrevealed cards, and a proof contains only hashes. |
| Distribution is uniform | Yes, by construction | A uniform deck composed with any independent permutation is still uniform. |
| Protection against a malicious operator *reading* hole cards in memory | **No** | Inherent to server-dealt poker. Mental-poker protocols would remove it but are impractical for real-time browser play. |
| "Mathematically provably fair" | **Not claimed** | The protocol gives verifiable commitment integrity and deal-order unpredictability under the assumptions below, not a proof of an honest server. |

## Protocol (NOIR-CARD-v1)

1. **Commit (before hand *n*).** The server draws a uniformly shuffled deck `D[0..51]` and 52 independent 256-bit salts `s_i`.
   `leaf_i = SHA256("NOIR-CARD-v1" ‖ 0x00 ‖ commitId ‖ 0x00 ‖ i ‖ D[i] ‖ s_i)`, and the root is `R = Merkle(leaf_0 … leaf_51)`.
   `{commitId, R}` is broadcast to the table during the pause after hand *n−1* (`table:commitment` event) and stored on the hand row.
2. **Contribute.** Each seated client generates 32 random bytes in the browser and sends them for that `commitId`
   (`table:entropy`). The server acknowledges inclusion. Contributions are accepted only after `R` has been published and before the hand starts.
3. **Mix.** At hand start, `mix = SHA256("NOIR-MIX-v1" ‖ R ‖ (playerId ‖ entropy) sorted by playerId)`. The contribution list and `mix` are
   public (sent in `HAND_STARTED` and stored).
4. **Deal.** `P = FisherYates([0..51], HMAC-DRBG(mix))`. The *k*-th card dealt is `D[P[k]]`. This order includes burns.
5. **Reveal.** Whenever a card becomes visible to a viewer (own hole cards privately, board cards and showdown hands publicly),
   the server sends `{dealIndex k, position P[k], card, salt, merkleProof}`. The client checks
   `P[k]` recomputed from `mix`, and the leaf hash plus proof against `R`.
6. **Export.** After the hand, a player can download a *verification bundle* (commitment, contributions, mix, every reveal they
   saw, and the public event hash chain) and run `noir-verify bundle.json` offline.

### Why the operator cannot steer cards

`D` is bound by `R` before any player entropy exists. A player's entropy is unpredictable to the server, so when the server
commits it cannot know which position lands at which deal index. "Stacking" `D` is therefore useless. Afterwards, `D` cannot
change without breaking the proofs.

### Assumptions and limitations

* **At least one honest contributor.** If no player contributes (for example a client with an old version), deal order falls back to
  `mix` over the root alone. Integrity then rests on trusting the server CSPRNG, and the UI shows "No player entropy for this hand".
* **Selective omission.** The server could drop a contribution to influence the mix. This is **detectable**: each client
  checks that its acknowledged contribution appears in the published list and shows a warning if it does not.
* **Grinding by late contributors** cannot bias outcomes, because contributors do not know `D`.
* **Insider risk.** The process memory and `hand_secrets` contain the full deck. Access to `hand_secrets` requires the
  `fairness.investigate` permission, is audit-logged, and rows are purged after the retention period (default 90 days).
* **Client entropy** is not "browser randomness for the authoritative deck". The deck is generated server-side. Client input only
  re-indexes an already-uniform, already-committed deck.

## Hand event hash chain

Every engine event for a hand is stored in `hand_events` with
`hash = SHA256(prev_hash ‖ seq ‖ type ‖ canonicalJSON(payload))`. The chain continues across hands at a table
(`poker_tables.chain_head`). Tables are append-only via triggers (`forbid_mutation`), and only the retention job can
purge, by setting a session flag. Any edit to a stored event breaks the chain from that point on.
`admin_audit_log` is chained the same way.

## Dispute investigation

An administrator with `fairness.investigate` opens a hand and sees: the full event log with chain verification status,
the committed deck and salts (logged access), every player's actions with server timestamps and decision times, and the
recomputed reveals. Players see only what they were entitled to see during the hand.
