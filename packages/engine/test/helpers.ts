import { orderedDeck, startHand, applyAction, type Card, type HandConfig, type HandState, type PlayerCommand, type SeatInput, type Applied } from '../src/index.js';

export const cfg = (over: Partial<HandConfig> = {}): HandConfig => ({ smallBlind: 5, bigBlind: 10, ante: 0, maxSeats: 9, ...over });

/**
 * TEST ONLY: build a deck in deal order so hole cards and board are known.
 * holes: per seat, in the order cards are dealt (clockwise from left of the button).
 */
export function rigDeck(holesInDealOrder: [Card, Card][], board: Card[]): Card[] {
  const used = new Set<Card>([...holesInDealOrder.flat(), ...board]);
  const filler = orderedDeck().filter((c) => !used.has(c));
  const take = () => filler.shift()!;
  const deck: Card[] = [];
  for (const h of holesInDealOrder) deck.push(h[0]);
  for (const h of holesInDealOrder) deck.push(h[1]);
  deck.push(take(), board[0]!, board[1]!, board[2]!, take(), board[3]!, take(), board[4]!);
  while (deck.length < 52) deck.push(take());
  return deck;
}

export function seats(...stacks: number[]): SeatInput[] {
  return stacks.map((stack, i) => ({ seat: i, playerId: `p${i}`, stack }));
}

export class Table {
  state: HandState;
  log: Applied['events'] = [];
  constructor(config: HandConfig, players: SeatInput[], button: number, deck: Card[], id = 'h1') {
    const r = startHand(id, config, players, button, deck);
    this.state = r.state;
    this.log.push(...r.events);
  }
  act(seat: number, type: PlayerCommand['type'], amount?: number) {
    const r = applyAction(this.state, { seat, type, ...(amount !== undefined ? { amount } : {}) });
    if (!r.ok) throw new Error(`${r.code}: ${r.message} (seat ${seat} ${type} ${amount ?? ''})`);
    this.state = r.state;
    this.log.push(...r.events);
    return this;
  }
  try(seat: number, type: PlayerCommand['type'], amount?: number) {
    return applyAction(this.state, { seat, type, ...(amount !== undefined ? { amount } : {}) });
  }
  stack(seat: number) {
    return this.state.players.find((p) => p.seat === seat)!.stack;
  }
  events(type: string) {
    return this.log.filter((e) => e.event.type === type).map((e) => e.event as any);
  }
}
