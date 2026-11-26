-- NOIR initial schema. Forward-only; applied inside a transaction by the migration runner.
-- Amounts are BIGINT whole credits (display denomination: ALL). Credits are non-redeemable.

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS citext;     -- case-insensitive usernames/emails

-- ============================================================ identity & access
CREATE TABLE roles (
  id          SMALLSERIAL PRIMARY KEY,
  key         TEXT NOT NULL UNIQUE,               -- owner | admin | moderator | player
  name        TEXT NOT NULL,
  rank        SMALLINT NOT NULL                   -- higher = more privileged; staff cannot manage >= own rank
);

CREATE TABLE permissions (
  key         TEXT PRIMARY KEY,                   -- e.g. credits.grant
  description TEXT NOT NULL,
  high_risk   BOOLEAN NOT NULL DEFAULT false      -- requires MFA step-up
);

CREATE TABLE role_permissions (
  role_id        SMALLINT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_key TEXT NOT NULL REFERENCES permissions(key) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_key)
);

CREATE TABLE users (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id      BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE,   -- short "Player ID" shown in UI
  username       CITEXT NOT NULL UNIQUE CHECK (username ~ '^[A-Za-z0-9_]{3,20}$'),
  email          CITEXT UNIQUE,
  email_verified BOOLEAN NOT NULL DEFAULT false,
  role_id        SMALLINT NOT NULL REFERENCES roles(id),
  status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','banned','deactivated')),
  suspended_until TIMESTAMPTZ,
  chat_muted_until TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at     TIMESTAMPTZ
);
CREATE INDEX users_role_idx ON users(role_id);

CREATE TABLE user_credentials (
  user_id          UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  password_hash    TEXT NOT NULL,                 -- Argon2id PHC string
  password_changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  must_change_password BOOLEAN NOT NULL DEFAULT false,
  totp_secret_enc  TEXT,                          -- AES-256-GCM encrypted with server key
  totp_enabled     BOOLEAN NOT NULL DEFAULT false,
  totp_last_step   BIGINT,                        -- prevents TOTP code replay
  recovery_codes   TEXT[] NOT NULL DEFAULT '{}',  -- SHA-256 hashes, single use
  failed_logins    INT NOT NULL DEFAULT 0,
  locked_until     TIMESTAMPTZ
);

CREATE TABLE sessions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash    BYTEA NOT NULL UNIQUE,            -- SHA-256 of the opaque cookie token
  csrf_token    TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ NOT NULL,
  mfa_at        TIMESTAMPTZ,                      -- last MFA verification (step-up window)
  ip            INET,
  user_agent    TEXT,
  revoked_at    TIMESTAMPTZ,
  revoked_reason TEXT
);
CREATE INDEX sessions_user_idx ON sessions(user_id) WHERE revoked_at IS NULL;

CREATE TABLE login_events (
  id          BIGSERIAL PRIMARY KEY,
  user_id     UUID REFERENCES users(id) ON DELETE SET NULL,
  username_attempted CITEXT,
  success     BOOLEAN NOT NULL,
  reason      TEXT,
  ip          INET,
  user_agent  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX login_events_user_idx ON login_events(user_id, created_at DESC);

CREATE TABLE invitations (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code_hash   BYTEA NOT NULL UNIQUE,
  created_by  UUID NOT NULL REFERENCES users(id),
  role_id     SMALLINT NOT NULL REFERENCES roles(id),
  max_uses    INT NOT NULL DEFAULT 1 CHECK (max_uses > 0),
  uses        INT NOT NULL DEFAULT 0 CHECK (uses <= max_uses),
  expires_at  TIMESTAMPTZ NOT NULL,
  revoked_at  TIMESTAMPTZ,
  note        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE password_reset_tokens (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  BYTEA NOT NULL UNIQUE,
  created_by  UUID REFERENCES users(id),           -- admin who issued it, if any
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ
);

-- ============================================================ profiles & social
CREATE TABLE user_profiles (
  user_id       UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  display_name  TEXT NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 32),
  avatar_key    TEXT NOT NULL DEFAULT 'default',  -- chosen from the server-side avatar catalogue
  bio           TEXT CHECK (char_length(bio) <= 280),
  favorite_mode TEXT,
  equipped_frame TEXT,
  equipped_card_back TEXT,
  allow_dms     BOOLEAN NOT NULL DEFAULT true
);

CREATE TABLE friendships (
  user_a     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_b     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_a, user_b),
  CHECK (user_a < user_b)                         -- one row per pair
);

CREATE TABLE friend_requests (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  from_user  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_user    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status     TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','declined','cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  responded_at TIMESTAMPTZ,
  CHECK (from_user <> to_user)
);
CREATE UNIQUE INDEX friend_requests_pending_uq ON friend_requests(from_user, to_user) WHERE status = 'pending';

CREATE TABLE user_blocks (
  blocker_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (blocker_id, blocked_id)
);

CREATE TABLE user_mutes (
  muter_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  muted_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (muter_id, muted_id)
);

-- ============================================================ credit ledger (append-only)
CREATE TABLE credit_ledger (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL REFERENCES users(id),
  seq            BIGINT NOT NULL,                 -- per-user sequence; (user_id, seq) unique → no forks
  amount         BIGINT NOT NULL CHECK (amount <> 0),
  denomination   TEXT NOT NULL DEFAULT 'ALL',
  entry_type     TEXT NOT NULL CHECK (entry_type IN (
                   'ADMIN_GRANT','ADMIN_CORRECTION','TABLE_BUY_IN','TABLE_CASH_OUT',
                   'TOURNAMENT_ENTRY','TOURNAMENT_REFUND','SIGNUP_BONUS','HAND_VOID_REFUND')),
  balance_before BIGINT NOT NULL,
  balance_after  BIGINT NOT NULL CHECK (balance_after >= 0),
  reason         TEXT,
  admin_id       UUID REFERENCES users(id),
  reference_type TEXT,                            -- table_session | tournament | ledger_entry …
  reference_id   TEXT,
  idempotency_key TEXT UNIQUE,
  metadata       JSONB NOT NULL DEFAULT '{}',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, seq),
  CHECK (balance_after = balance_before + amount),
  CHECK (entry_type NOT IN ('ADMIN_GRANT','ADMIN_CORRECTION') OR (admin_id IS NOT NULL AND reason IS NOT NULL AND char_length(reason) >= 5))
);
CREATE INDEX credit_ledger_user_idx ON credit_ledger(user_id, seq DESC);
CREATE INDEX credit_ledger_created_idx ON credit_ledger(created_at DESC);
CREATE INDEX credit_ledger_admin_idx ON credit_ledger(admin_id) WHERE admin_id IS NOT NULL;

CREATE FUNCTION forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END $$;
CREATE TRIGGER credit_ledger_append_only BEFORE UPDATE OR DELETE ON credit_ledger
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE account_limits (
  user_id          UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  max_buy_in       BIGINT CHECK (max_buy_in > 0),
  max_daily_buy_in BIGINT CHECK (max_daily_buy_in > 0),
  updated_by       UUID REFERENCES users(id),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================ tables & games
CREATE TABLE poker_tables (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL CHECK (char_length(name) BETWEEN 3 AND 40),
  variant       TEXT NOT NULL DEFAULT 'NLHE' CHECK (variant IN ('NLHE')),
  max_seats     SMALLINT NOT NULL CHECK (max_seats BETWEEN 2 AND 9),
  small_blind   BIGINT NOT NULL CHECK (small_blind > 0),
  big_blind     BIGINT NOT NULL CHECK (big_blind >= small_blind),
  ante          BIGINT NOT NULL DEFAULT 0 CHECK (ante >= 0),
  min_buy_in    BIGINT NOT NULL,
  max_buy_in    BIGINT NOT NULL,
  action_seconds SMALLINT NOT NULL DEFAULT 25 CHECK (action_seconds BETWEEN 5 AND 120),
  is_private    BOOLEAN NOT NULL DEFAULT false,
  access_code_hash TEXT,                          -- Argon2id of private access code
  host_id       UUID REFERENCES users(id),
  tournament_id UUID,                             -- FK added below
  status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','paused','closed')),
  closes_at     TIMESTAMPTZ,                      -- game duration option for private tables
  created_by    UUID REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  chain_head    TEXT NOT NULL DEFAULT repeat('0', 64),  -- hash-chain head across this table's hands
  CHECK (min_buy_in >= big_blind AND max_buy_in >= min_buy_in),
  CHECK (NOT is_private OR access_code_hash IS NOT NULL OR host_id IS NOT NULL)
);
CREATE INDEX poker_tables_status_idx ON poker_tables(status) WHERE status <> 'closed';

CREATE TABLE table_invites (
  table_id   UUID NOT NULL REFERENCES poker_tables(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invited_by UUID NOT NULL REFERENCES users(id),
  PRIMARY KEY (table_id, user_id)
);

-- A player's presence at a seat, from buy-in to cash-out. Stack is updated after every hand.
CREATE TABLE table_sessions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  table_id     UUID NOT NULL REFERENCES poker_tables(id),
  user_id      UUID NOT NULL REFERENCES users(id),
  seat         SMALLINT NOT NULL CHECK (seat BETWEEN 0 AND 8),
  buy_in_total BIGINT NOT NULL CHECK (buy_in_total > 0),
  stack        BIGINT NOT NULL CHECK (stack >= 0),
  sat_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  left_at      TIMESTAMPTZ,
  cash_out     BIGINT
);
CREATE UNIQUE INDEX table_sessions_seat_uq ON table_sessions(table_id, seat) WHERE left_at IS NULL;
CREATE UNIQUE INDEX table_sessions_user_uq ON table_sessions(table_id, user_id) WHERE left_at IS NULL;
CREATE INDEX table_sessions_open_idx ON table_sessions(user_id) WHERE left_at IS NULL;

CREATE TABLE hands (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  table_id      UUID NOT NULL REFERENCES poker_tables(id),
  hand_no       BIGINT NOT NULL,
  variant       TEXT NOT NULL DEFAULT 'NLHE',
  button_seat   SMALLINT NOT NULL,
  small_blind   BIGINT NOT NULL,
  big_blind     BIGINT NOT NULL,
  ante          BIGINT NOT NULL DEFAULT 0,
  deck_commit_id TEXT NOT NULL,
  deck_root     TEXT NOT NULL,                    -- published Merkle root
  entropy_mix   TEXT NOT NULL,                    -- published mix value
  board         TEXT[] NOT NULL DEFAULT '{}',
  status        TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','complete','voided')),
  started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at      TIMESTAMPTZ,
  total_pot     BIGINT,
  UNIQUE (table_id, hand_no)
);
CREATE INDEX hands_running_idx ON hands(status) WHERE status = 'running';

-- Secret deck material. Readable only via the fairness.investigate permission; purged by retention job.
CREATE TABLE hand_secrets (
  hand_id     UUID PRIMARY KEY REFERENCES hands(id) ON DELETE CASCADE,
  deck        TEXT[] NOT NULL,                    -- committed order
  salts       TEXT[] NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE hand_entropy (
  hand_id     UUID NOT NULL REFERENCES hands(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES users(id),
  entropy     TEXT NOT NULL CHECK (entropy ~ '^[0-9a-f]{64}$'),
  PRIMARY KEY (hand_id, user_id)
);

CREATE TABLE hand_players (
  hand_id       UUID NOT NULL REFERENCES hands(id) ON DELETE CASCADE,
  user_id       UUID NOT NULL REFERENCES users(id),
  seat          SMALLINT NOT NULL,
  starting_stack BIGINT NOT NULL,
  final_stack   BIGINT,
  net           BIGINT,
  hole_cards    TEXT[],                           -- stored for owner's history + dispute review
  shown         BOOLEAN NOT NULL DEFAULT false,
  folded        BOOLEAN NOT NULL DEFAULT false,
  went_to_showdown BOOLEAN NOT NULL DEFAULT false,
  won           BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY (hand_id, user_id),
  UNIQUE (hand_id, seat)
);
CREATE INDEX hand_players_user_idx ON hand_players(user_id);

-- Hash-chained, append-only event log (public + private visibility recorded).
CREATE TABLE hand_events (
  hand_id     UUID NOT NULL REFERENCES hands(id) ON DELETE CASCADE,
  seq         INT NOT NULL,
  type        TEXT NOT NULL,
  visibility  TEXT NOT NULL,                      -- 'public' | 'seat:<n>'
  payload     JSONB NOT NULL,
  prev_hash   TEXT NOT NULL,
  hash        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (hand_id, seq)
);
CREATE TRIGGER hand_events_append_only BEFORE UPDATE OR DELETE ON hand_events
  FOR EACH ROW WHEN (current_setting('noir.retention', true) IS DISTINCT FROM 'on')
  EXECUTE FUNCTION forbid_mutation();

CREATE TABLE player_actions (
  action_id   UUID PRIMARY KEY,                   -- client-generated idempotency key
  hand_id     UUID NOT NULL REFERENCES hands(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES users(id),
  seat        SMALLINT NOT NULL,
  street      TEXT NOT NULL,
  action      TEXT NOT NULL,
  amount      BIGINT,
  accepted    BOOLEAN NOT NULL,
  reject_code TEXT,
  server_ts   TIMESTAMPTZ NOT NULL DEFAULT now(),
  decision_ms INT                                 -- time from TURN to action (bot/collusion analytics)
);
CREATE INDEX player_actions_user_idx ON player_actions(user_id, server_ts DESC);

CREATE TABLE hand_pots (
  hand_id     UUID NOT NULL REFERENCES hands(id) ON DELETE CASCADE,
  pot_index   SMALLINT NOT NULL,
  amount      BIGINT NOT NULL,
  eligible_seats SMALLINT[] NOT NULL,
  winners     JSONB NOT NULL,                     -- [{seat, amount}]
  hand_name   TEXT,
  PRIMARY KEY (hand_id, pot_index)
);

-- ============================================================ tournaments
CREATE TABLE tournament_structures (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  levels      JSONB NOT NULL,                     -- [{level, sb, bb, ante, minutes, isBreak}]
  created_by  UUID REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE tournaments (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name             TEXT NOT NULL,
  kind             TEXT NOT NULL CHECK (kind IN ('sng','scheduled','private')),
  structure_id     UUID NOT NULL REFERENCES tournament_structures(id),
  status           TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','registering','running','paused','finished','cancelled')),
  starts_at        TIMESTAMPTZ,
  late_reg_minutes INT NOT NULL DEFAULT 0,
  min_players      INT NOT NULL DEFAULT 2 CHECK (min_players >= 2),
  max_players      INT NOT NULL CHECK (max_players >= min_players),
  seats_per_table  SMALLINT NOT NULL DEFAULT 9 CHECK (seats_per_table BETWEEN 2 AND 9),
  starting_stack   BIGINT NOT NULL CHECK (starting_stack > 0),
  entry_fee        BIGINT NOT NULL DEFAULT 0 CHECK (entry_fee >= 0),  -- game credits only
  rewards          JSONB NOT NULL DEFAULT '[]',   -- cosmetic/XP rewards by finishing place
  is_private       BOOLEAN NOT NULL DEFAULT false,
  current_level    INT NOT NULL DEFAULT 0,
  level_started_at TIMESTAMPTZ,
  created_by       UUID REFERENCES users(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at      TIMESTAMPTZ
);
ALTER TABLE poker_tables ADD CONSTRAINT poker_tables_tournament_fk FOREIGN KEY (tournament_id) REFERENCES tournaments(id);

CREATE TABLE tournament_participants (
  tournament_id UUID NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  user_id       UUID NOT NULL REFERENCES users(id),
  registered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  status        TEXT NOT NULL DEFAULT 'registered' CHECK (status IN ('registered','playing','eliminated','winner','unregistered')),
  table_id      UUID REFERENCES poker_tables(id),
  seat          SMALLINT,
  stack         BIGINT,
  finish_place  INT,
  eliminated_at TIMESTAMPTZ,
  PRIMARY KEY (tournament_id, user_id)
);

-- ============================================================ progression
CREATE TABLE levels (
  level        INT PRIMARY KEY CHECK (level >= 1),
  xp_required  BIGINT NOT NULL UNIQUE CHECK (xp_required >= 0),
  rank_key     TEXT NOT NULL,                     -- rookie … noir_elite
  reward_item_key TEXT
);

CREATE TABLE xp_ledger (
  id          BIGSERIAL PRIMARY KEY,
  user_id     UUID NOT NULL REFERENCES users(id),
  amount      INT NOT NULL CHECK (amount > 0),
  source      TEXT NOT NULL,                      -- hand_played | quest | achievement | tournament | admin
  reference_id TEXT,
  rule_version INT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, source, reference_id)          -- an event can award XP once
);
CREATE INDEX xp_ledger_user_idx ON xp_ledger(user_id, created_at DESC);
CREATE TRIGGER xp_ledger_append_only BEFORE UPDATE OR DELETE ON xp_ledger
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE user_progress (                       -- derived cache, rebuildable from xp_ledger
  user_id     UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  xp_total    BIGINT NOT NULL DEFAULT 0,
  level       INT NOT NULL DEFAULT 1,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE level_history (
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  level      INT NOT NULL,
  reached_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, level)
);

CREATE TABLE player_stats (                        -- derived counters updated in the hand-end transaction
  user_id            UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  hands_played       BIGINT NOT NULL DEFAULT 0,
  hands_won          BIGINT NOT NULL DEFAULT 0,
  showdowns          BIGINT NOT NULL DEFAULT 0,
  showdowns_won      BIGINT NOT NULL DEFAULT 0,
  folds              BIGINT NOT NULL DEFAULT 0,
  preflop_folds      BIGINT NOT NULL DEFAULT 0,
  total_pot_won      BIGINT NOT NULL DEFAULT 0,
  largest_pot        BIGINT NOT NULL DEFAULT 0,
  seconds_played     BIGINT NOT NULL DEFAULT 0,
  tournaments_played BIGINT NOT NULL DEFAULT 0,
  tournament_wins    BIGINT NOT NULL DEFAULT 0,
  tournament_points  BIGINT NOT NULL DEFAULT 0,
  current_streak     INT NOT NULL DEFAULT 0,
  best_streak        INT NOT NULL DEFAULT 0,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE achievements (
  key         TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT NOT NULL,
  rarity      TEXT NOT NULL CHECK (rarity IN ('common','uncommon','rare','epic','legendary')),
  metric      TEXT NOT NULL,                      -- hands_played | hands_won | tournaments_played …
  threshold   BIGINT NOT NULL CHECK (threshold > 0),
  xp_reward   INT NOT NULL DEFAULT 0,
  icon        TEXT NOT NULL,
  active      BOOLEAN NOT NULL DEFAULT true
);

CREATE TABLE user_achievements (
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  achievement_key TEXT NOT NULL REFERENCES achievements(key),
  progress       BIGINT NOT NULL DEFAULT 0,
  unlocked_at    TIMESTAMPTZ,
  PRIMARY KEY (user_id, achievement_key)
);

CREATE TABLE quests (
  key          TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  period       TEXT NOT NULL CHECK (period IN ('daily','weekly')),
  metric       TEXT NOT NULL,
  target       INT NOT NULL CHECK (target > 0),
  xp_reward    INT NOT NULL CHECK (xp_reward >= 0),
  item_reward  TEXT,
  active       BOOLEAN NOT NULL DEFAULT true
);

CREATE TABLE quest_progress (
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  quest_key    TEXT NOT NULL REFERENCES quests(key),
  period_start DATE NOT NULL,
  progress     INT NOT NULL DEFAULT 0,
  completed_at TIMESTAMPTZ,
  PRIMARY KEY (user_id, quest_key, period_start)
);

-- ============================================================ gifts & cosmetics
CREATE TABLE items (
  key          TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('gift','badge','frame','card_back','table_theme','emote','effect')),
  rarity       TEXT NOT NULL CHECK (rarity IN ('common','uncommon','rare','epic','legendary')),
  giftable     BOOLEAN NOT NULL DEFAULT false,
  seasonal_from DATE,
  seasonal_to  DATE,
  daily_send_limit INT NOT NULL DEFAULT 10,
  animation    TEXT,
  active       BOOLEAN NOT NULL DEFAULT true
);

CREATE TABLE user_inventory (
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_key   TEXT NOT NULL REFERENCES items(key),
  quantity   INT NOT NULL CHECK (quantity >= 0),
  acquired_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, item_key)
);

-- Gifts are free social items granted from a daily allowance; they carry no credit value.
CREATE TABLE gift_history (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  from_user  UUID NOT NULL REFERENCES users(id),
  to_user    UUID NOT NULL REFERENCES users(id),
  item_key   TEXT NOT NULL REFERENCES items(key),
  table_id   UUID REFERENCES poker_tables(id),
  message    TEXT CHECK (char_length(message) <= 120),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (from_user <> to_user)
);
CREATE INDEX gift_history_to_idx ON gift_history(to_user, created_at DESC);
CREATE INDEX gift_history_from_idx ON gift_history(from_user, created_at DESC);

-- ============================================================ chat, notifications, moderation
CREATE TABLE chat_channels (
  id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind      TEXT NOT NULL CHECK (kind IN ('lobby','table','dm')),
  table_id  UUID REFERENCES poker_tables(id) ON DELETE CASCADE,
  dm_user_a UUID REFERENCES users(id),
  dm_user_b UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((kind = 'table') = (table_id IS NOT NULL)),
  CHECK ((kind = 'dm') = (dm_user_a IS NOT NULL AND dm_user_b IS NOT NULL AND dm_user_a < dm_user_b))
);
CREATE UNIQUE INDEX chat_channels_lobby_uq ON chat_channels(kind) WHERE kind = 'lobby';
CREATE UNIQUE INDEX chat_channels_table_uq ON chat_channels(table_id) WHERE kind = 'table';
CREATE UNIQUE INDEX chat_channels_dm_uq ON chat_channels(dm_user_a, dm_user_b) WHERE kind = 'dm';

CREATE TABLE chat_messages (
  id         BIGSERIAL PRIMARY KEY,
  channel_id UUID NOT NULL REFERENCES chat_channels(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES users(id),
  body       TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 300),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  hidden_at  TIMESTAMPTZ,
  hidden_by  UUID REFERENCES users(id)
);
CREATE INDEX chat_messages_channel_idx ON chat_messages(channel_id, id DESC);

CREATE TABLE notifications (
  id         BIGSERIAL PRIMARY KEY,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,
  title      TEXT NOT NULL,
  body       TEXT,
  data       JSONB NOT NULL DEFAULT '{}',
  read_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX notifications_user_idx ON notifications(user_id, id DESC);

CREATE TABLE announcements (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title      TEXT NOT NULL,
  body       TEXT NOT NULL,
  published_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  created_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE reports (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id UUID NOT NULL REFERENCES users(id),
  target_id   UUID NOT NULL REFERENCES users(id),
  category    TEXT NOT NULL CHECK (category IN ('chat_abuse','cheating','collusion','spam','other')),
  details     TEXT CHECK (char_length(details) <= 1000),
  context     JSONB NOT NULL DEFAULT '{}',        -- message id / hand id
  status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','reviewing','actioned','dismissed')),
  handled_by  UUID REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ
);
CREATE INDEX reports_status_idx ON reports(status, created_at);

CREATE TABLE moderation_actions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  target_id   UUID NOT NULL REFERENCES users(id),
  moderator_id UUID NOT NULL REFERENCES users(id),
  action      TEXT NOT NULL CHECK (action IN ('warn','chat_mute','suspend','ban','unban','hide_message')),
  reason      TEXT NOT NULL,
  until       TIMESTAMPTZ,
  report_id   UUID REFERENCES reports(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE integrity_alerts (                    -- bot/collusion indicators for human review
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind       TEXT NOT NULL,
  user_ids   UUID[] NOT NULL,
  evidence   JSONB NOT NULL,
  status     TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','dismissed','actioned')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_by UUID REFERENCES users(id)
);

-- ============================================================ audit & config
CREATE TABLE admin_audit_log (
  id          BIGSERIAL PRIMARY KEY,
  actor_id    UUID REFERENCES users(id),
  action      TEXT NOT NULL,
  target_type TEXT,
  target_id   TEXT,
  details     JSONB NOT NULL DEFAULT '{}',
  ip          INET,
  prev_hash   TEXT NOT NULL,
  hash        TEXT NOT NULL,                      -- hash-chained for tamper evidence
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX admin_audit_actor_idx ON admin_audit_log(actor_id, id DESC);
CREATE TRIGGER admin_audit_append_only BEFORE UPDATE OR DELETE ON admin_audit_log
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE security_events (
  id         BIGSERIAL PRIMARY KEY,
  kind       TEXT NOT NULL,                       -- lockout | csrf_reject | ws_forged | rate_limited …
  severity   TEXT NOT NULL CHECK (severity IN ('info','warn','high')),
  user_id    UUID REFERENCES users(id),
  ip         INET,
  details    JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX security_events_created_idx ON security_events(created_at DESC);

CREATE TABLE app_config (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL,
  updated_by UUID REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE backup_runs (
  id          BIGSERIAL PRIMARY KEY,
  kind        TEXT NOT NULL CHECK (kind IN ('backup','restore_test')),
  started_at  TIMESTAMPTZ NOT NULL,
  finished_at TIMESTAMPTZ,
  ok          BOOLEAN,
  file        TEXT,
  bytes       BIGINT,
  details     TEXT
);
