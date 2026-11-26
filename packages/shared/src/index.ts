/**
 * Shared contracts between NOIR server and client. Every HTTP body and WebSocket payload is
 * validated with these schemas on the server. Nothing here is secret.
 */
import { z } from 'zod';

export const USERNAME = z.string().regex(/^[A-Za-z0-9_]{3,20}$/, 'Username must be 3–20 letters, digits or underscores.');
export const PASSWORD = z.string().min(10, 'Password must be at least 10 characters.').max(128);
export const DISPLAY_NAME = z.string().trim().min(1).max(32);
export const UUID = z.uuid();
export const TOTP_CODE = z.string().regex(/^\d{6}$/, 'Enter the 6-digit code.');
export const ENTROPY = z.string().regex(/^[0-9a-f]{64}$/);
export const AMOUNT = z.number().int().positive().max(1_000_000_000_000);

// ------------------------------------------------------------------ HTTP bodies
export const LoginBody = z.strictObject({ username: z.string().min(1).max(64), password: z.string().min(1).max(128), totp: TOTP_CODE.optional(), recoveryCode: z.string().regex(/^[A-Za-z0-9]{10}$/, 'Recovery codes are 10 letters or digits.').optional() });
export const RegisterBody = z.strictObject({ inviteCode: z.string().min(8).max(64), username: USERNAME, displayName: DISPLAY_NAME, password: PASSWORD });
export const ChangePasswordBody = z.strictObject({ currentPassword: z.string().min(1).max(128), newPassword: PASSWORD });
export const ResetPasswordBody = z.strictObject({ token: z.string().min(20).max(128), newPassword: PASSWORD });
export const MfaEnableBody = z.strictObject({ code: TOTP_CODE });
export const StepUpBody = z.strictObject({ code: TOTP_CODE });
export const ProfileUpdateBody = z.strictObject({
  displayName: DISPLAY_NAME.optional(),
  avatarKey: z.string().regex(/^[a-z0-9_]{1,32}$/).optional(),
  bio: z.string().max(280).optional(),
  allowDms: z.boolean().optional(),
  equippedFrame: z.string().max(40).nullable().optional(),
  equippedCardBack: z.string().max(40).nullable().optional(),
});

export const AdminCreateUserBody = z.strictObject({ username: USERNAME, displayName: DISPLAY_NAME, email: z.email().optional(), role: z.enum(['player', 'moderator', 'admin']) });
export const AdminInviteBody = z.strictObject({ role: z.enum(['player', 'moderator']).default('player'), maxUses: z.number().int().min(1).max(100).default(1), expiresInHours: z.number().int().min(1).max(24 * 30).default(72), note: z.string().max(200).optional() });
export const AdminCreditBody = z.strictObject({
  userId: UUID,
  amount: z.number().int().refine((v) => v !== 0 && Math.abs(v) <= 1_000_000_000, 'Amount must be non-zero and within limits.'),
  kind: z.enum(['grant', 'correction']),
  reason: z.string().trim().min(5).max(500),
  idempotencyKey: z.uuid(),
});
export const AdminUserStatusBody = z.strictObject({ status: z.enum(['active', 'suspended', 'banned', 'deactivated']), reason: z.string().trim().min(3).max(500), until: z.iso.datetime().optional() });
export const AdminRoleBody = z.strictObject({ role: z.enum(['player', 'moderator', 'admin']) });
export const AdminMuteBody = z.strictObject({ minutes: z.number().int().min(1).max(60 * 24 * 30), reason: z.string().trim().min(3).max(500) });
export const AdminLimitsBody = z.strictObject({ maxBuyIn: AMOUNT.nullable(), maxDailyBuyIn: AMOUNT.nullable() });

export const CreateTableBody = z
  .strictObject({
    name: z.string().trim().min(3).max(40),
    maxSeats: z.number().int().min(2).max(9),
    smallBlind: AMOUNT,
    bigBlind: AMOUNT,
    ante: z.number().int().min(0).default(0),
    minBuyIn: AMOUNT,
    maxBuyIn: AMOUNT,
    actionSeconds: z.number().int().min(5).max(120).default(25),
    isPrivate: z.boolean().default(false),
    accessCode: z.string().min(4).max(32).optional(),
    durationMinutes: z.number().int().min(15).max(24 * 60).optional(),
  })
  .refine((t) => t.bigBlind >= t.smallBlind, 'Big blind must be at least the small blind.')
  .refine((t) => t.minBuyIn >= t.bigBlind * 10 && t.maxBuyIn >= t.minBuyIn, 'Buy-in range must be valid (minimum at least 10 big blinds).')
  .refine((t) => !t.isPrivate || !!t.accessCode, 'Private tables need an access code.');

export const SendGiftBody = z.strictObject({ toUserId: UUID, itemKey: z.string().max(40), tableId: UUID.optional(), message: z.string().max(120).optional() });
export const ReportBody = z.strictObject({ targetUserId: UUID, category: z.enum(['chat_abuse', 'cheating', 'collusion', 'spam', 'other']), details: z.string().max(1000).optional(), context: z.record(z.string(), z.string().max(100)).optional() });

// ------------------------------------------------------------------ WebSocket (client → server)
export const WsWatchTable = z.strictObject({ tableId: UUID });
export const WsSit = z.strictObject({ tableId: UUID, seat: z.number().int().min(0).max(8), buyIn: AMOUNT, accessCode: z.string().max(32).optional() });
export const WsLeave = z.strictObject({ tableId: UUID });
export const WsSitOut = z.strictObject({ tableId: UUID, sitOut: z.boolean() });
export const WsRebuy = z.strictObject({ tableId: UUID, amount: AMOUNT });
export const WsAction = z.strictObject({
  tableId: UUID,
  handId: UUID,
  actionId: UUID,
  expectedSeq: z.number().int().min(0),
  type: z.enum(['fold', 'check', 'call', 'bet', 'raise', 'allin']),
  amount: z.number().int().min(0).optional(),
});
export const WsEntropy = z.strictObject({ tableId: UUID, commitId: z.string().max(80), entropy: ENTROPY });
export const WsChatSend = z.strictObject({ channel: z.union([z.literal('lobby'), z.string().regex(/^table:[0-9a-f-]{36}$/)]), body: z.string().min(1).max(300) });

export type Ack<T = unknown> = { ok: true; data?: T } | { ok: false; error: string; code?: string };

// ------------------------------------------------------------------ shared view types
export interface TableSummary {
  id: string;
  name: string;
  variant: 'NLHE';
  maxSeats: number;
  seated: number;
  smallBlind: number;
  bigBlind: number;
  minBuyIn: number;
  maxBuyIn: number;
  isPrivate: boolean;
  status: string;
  handsPerHour: number | null;
}

export interface SeatView {
  seat: number;
  userId: string;
  displayName: string;
  avatarKey: string;
  level: number;
  stack: number;
  sittingOut: boolean;
  connected: boolean;
}

export interface CardRevealDto {
  dealIndex: number;
  position: number;
  card: string;
  salt: string;
  proof: { side: 'L' | 'R'; hash: string }[];
}

export interface FairnessInfo {
  commitId: string;
  root: string;
  mix: string;
  contributions: { playerId: string; entropy: string }[];
}

export const DENOMINATION = 'ALL';
export const CREDITS_DISCLAIMER = 'Game credits only. Non-redeemable, with no cash value.';

export const RANKS = ['rookie', 'amateur', 'regular', 'skilled', 'expert', 'master', 'elite', 'legend', 'noir_elite'] as const;
export const RANK_NAMES: Record<(typeof RANKS)[number], string> = {
  rookie: 'Rookie', amateur: 'Amateur', regular: 'Regular', skilled: 'Skilled', expert: 'Expert', master: 'Master', elite: 'Elite', legend: 'Legend', noir_elite: 'Noir Elite',
};
