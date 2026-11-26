/** Card codes are two characters: rank (23456789TJQKA) + suit (cdhs), e.g. "As", "Td". */
export type Suit = 'c' | 'd' | 'h' | 's';
export type Card = string;

export const RANKS = '23456789TJQKA';
export const SUITS: readonly Suit[] = ['c', 'd', 'h', 's'];

/** Rank value 2..14 (ace high). */
export function rankOf(card: Card): number {
  const idx = RANKS.indexOf(card[0] ?? '');
  if (idx < 0 || card.length !== 2) throw new Error(`Invalid card: ${card}`);
  return idx + 2;
}

export function suitOf(card: Card): Suit {
  const s = card[1];
  if (s !== 'c' && s !== 'd' && s !== 'h' && s !== 's') throw new Error(`Invalid card: ${card}`);
  return s;
}

export function isCard(value: unknown): value is Card {
  return typeof value === 'string' && value.length === 2 && RANKS.includes(value[0]!) && 'cdhs'.includes(value[1]!);
}

/** A fresh, ordered 52-card deck. Never used for dealing without a shuffle. */
export function orderedDeck(): Card[] {
  const deck: Card[] = [];
  for (const s of SUITS) for (const r of RANKS) deck.push(`${r}${s}`);
  return deck;
}
