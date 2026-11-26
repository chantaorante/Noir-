# Poker Engine

Package: `packages/engine` (`@noir/engine`). Pure TypeScript with **no I/O, no clock and no randomness inside the
state machine**. The server feeds it a deck (already in deal order) and commands. It returns a new state plus
events tagged with visibility. Because it is deterministic, every rule is unit-testable and every hand is replayable.

## Modules

| File | Responsibility |
|---|---|
| `cards.ts` | Card codes (`"As"`, `"Td"`), ranks and suits, ordered deck |
| `rng.ts` | `cryptoRandom` (OS CSPRNG via `crypto.randomInt`) and `HmacDrbg` (deterministic; public deal permutation + tests only) |
| `shuffle.ts` | Fisher–Yates (Durstenfeld) shuffle |
| `evaluator.ts` | Best 5-of-7 evaluation to a totally ordered integer score |
| `pots.ts` | Main/side pot construction, uncalled-bet refunds, odd-chip split |
| `holdem.ts` | NLHE hand state machine, legal options, timeout policy, per-viewer projection, button rotation |
| `fairness.ts` | Deck commitment, entropy mix, deal permutation, Merkle proofs, event hash chain |
| `cli/verify.ts` | `noir-verify bundle.json`, an independent offline verifier |

## State machine

```
            startHand()
                │  antes → blinds → 2 hole cards each (one at a time, from left of button)
                ▼
  ┌──────── PREFLOP ──round closed──▶ FLOP ──▶ TURN ──▶ RIVER ──round closed──▶ SHOWDOWN ─▶ COMPLETE
  │             │                       │        │        │
  │             └───── only one player not folded (any street) ─────────────────────────────▶ COMPLETE
  │                                                                                 (no cards shown)
  └── ≤1 player can still bet (others all-in) when a round closes → deal remaining board → SHOWDOWN
```

**A betting round closes** when every player who can act (`status = active`) has acted at least once this round
and has matched `currentBet`. A lone active player who already matches the bet does not act again.

## Rules implemented

* **Positions.** With 3 or more players, SB and BB are the next two seats clockwise from the button. **Heads-up**, the button posts the SB and
  acts first pre-flop and last post-flop.
* **Action order.** Pre-flop starts left of the BB. Post-flop starts at the first active seat left of the button.
* **Blinds.** A short blind posts all it has (all-in). Others must still call the **full** big blind.
* **Antes** (tournaments) are dead money counted in `totalCommitted`.
* **Bet/raise amounts** use "raise **to**" semantics. The minimum opening bet is 1 BB. The minimum raise is the last *full* raise
  increment on the street. All-in for less is always allowed.
* **Incomplete all-in raises** raise the price but do not change the minimum increment, and they **do not reopen** betting for
  players who already acted. Each player records `betLevelWhenActed`. They may re-raise only if the bet has grown by at least one
  full raise increment since they last acted, so several short all-ins can add up to a full raise.
* **No raise when nobody can respond.** If every opponent is all-in or folded, only fold/check/call are offered.
* **Side pots.** Each distinct total-contribution level forms a slice. Slices with the same eligible set merge. Folded chips stay in
  the pot, but folded seats are never eligible. A top slice with a single live contributor is an **uncalled bet** and is returned.
* **Split pots.** Equal score splits equally. **Odd chips** go one at a time clockwise from the first seat left of the button.
* **Showdown order and mucking.** The last aggressor of the final round shows first, otherwise the first live seat left of the button.
  A later hand that cannot win or tie any pot it is eligible for is auto-mucked (not revealed). In an **all-in runout**
  every live hand is tabled.
* **Burn cards** are consumed before each street and never revealed.
* **Timeouts.** `timeoutAction()` gives *check* if free, else *fold*. The server applies it when the action clock expires (including
  for disconnected players) and then marks the player sitting out after N consecutive timeouts.
* **Button rotation.** The button moves to the next dealt-in seat clockwise (simplified "moving button"). v1 does not track missed blinds:
  a returning player is dealt in on the next hand. This is a documented simplification, to be revisited with a dead-button rule.

## Security-relevant properties

* Commands from any seat other than `toActSeat` are rejected (`NOT_YOUR_TURN`). Duplicate or stale commands are therefore harmless at
  the engine level. The server additionally de-duplicates by `actionId` and checks `seq`.
* Amounts must be safe integers within `[minTo, maxTo]`. Fractions, negatives and over-stack amounts are rejected.
* `projectForViewer(state, seat)` is the only way state leaves the server. It includes hole cards only for the viewer's seat,
  or for seats revealed at showdown.
* Private events (`HOLE_CARDS`) carry `visibility: {to:'seat'}` and are routed only to that seat's sockets.

## Extending to other variants

The NLHE rules live in `holdem.ts`. A new variant (for example Pot-Limit Omaha) adds its own deal pattern (4 hole cards),
evaluator constraint (exactly 2 + 3) and bet sizing (`maxTo` = pot limit), reusing `pots.ts`, `fairness.ts` and the
table actor unchanged. The `variant` column already exists on `poker_tables` and `hands`.

## Tests

See [TESTING.md](TESTING.md). These include exhaustive 5-card frequency checks (all 2,598,960 hands), 20,000 random 7-card hands
checked against brute force, chi-square uniformity of the shuffle, side-pot/odd-chip/heads-up/incomplete-raise scenarios,
and a 10,000-hand randomized property test for chip conservation and termination.
