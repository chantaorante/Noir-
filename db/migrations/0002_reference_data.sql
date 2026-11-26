-- Reference data required in every environment (not test fixtures).
INSERT INTO roles (key, name, rank) VALUES
  ('owner','Owner',100), ('admin','Administrator',80), ('moderator','Moderator',50), ('player','Player',10);

INSERT INTO permissions (key, description, high_risk) VALUES
  ('admin.access',        'Open the administration panel', false),
  ('users.view',          'View user accounts and activity', false),
  ('users.create',        'Create user accounts and invitations', true),
  ('users.edit',          'Edit user details', false),
  ('users.suspend',       'Suspend, ban or reactivate accounts', false),
  ('users.reset_password','Issue password reset links', true),
  ('users.revoke_sessions','Revoke user sessions', false),
  ('roles.assign',        'Change user roles', true),
  ('credits.view',        'View credit ledgers', false),
  ('credits.grant',       'Grant or correct virtual credits', true),
  ('credits.limits',      'Set account limits', true),
  ('credits.export',      'Export ledger reports', true),
  ('tables.manage',       'Create and configure tables', false),
  ('tournaments.manage',  'Create, start, pause and cancel tournaments', false),
  ('progression.manage',  'Configure XP, levels, missions and achievements', false),
  ('gifts.manage',        'Configure gifts and cosmetic items', false),
  ('announcements.manage','Publish announcements', false),
  ('chat.moderate',       'Hide messages, mute users, handle reports', false),
  ('audit.view',          'View audit and security logs', false),
  ('fairness.investigate','View secret deck material of past hands for disputes', true),
  ('system.view',         'View server, database and backup status', false),
  ('system.maintenance',  'Toggle maintenance mode and application configuration', true),
  ('config.security',     'Change security configuration', true);

INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, p.key FROM roles r CROSS JOIN permissions p WHERE r.key = 'owner';

INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, p.key FROM roles r JOIN permissions p ON p.key IN (
  'admin.access','users.view','users.create','users.edit','users.suspend','users.reset_password','users.revoke_sessions',
  'credits.view','credits.grant','credits.limits','credits.export','tables.manage','tournaments.manage','progression.manage',
  'gifts.manage','announcements.manage','chat.moderate','audit.view','fairness.investigate','system.view','system.maintenance')
WHERE r.key = 'admin';

INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, p.key FROM roles r JOIN permissions p ON p.key IN ('admin.access','users.view','chat.moderate','users.suspend')
WHERE r.key = 'moderator';

-- Levels 1..50. xp(level) = 100 * (level-1)^1.6 rounded; ranks every ~6 levels.
INSERT INTO levels (level, xp_required, rank_key)
SELECT l, CASE WHEN l = 1 THEN 0 ELSE round(100 * power(l - 1, 1.6))::bigint END,
  CASE WHEN l < 5 THEN 'rookie' WHEN l < 10 THEN 'amateur' WHEN l < 16 THEN 'regular' WHEN l < 22 THEN 'skilled'
       WHEN l < 28 THEN 'expert' WHEN l < 34 THEN 'master' WHEN l < 40 THEN 'elite' WHEN l < 50 THEN 'legend' ELSE 'noir_elite' END
FROM generate_series(1, 50) AS l;

INSERT INTO achievements (key, name, description, rarity, metric, threshold, xp_reward, icon) VALUES
  ('first_hand','First Hand','Play your first hand.','common','hands_played',1,25,'spade'),
  ('first_victory','First Victory','Win your first pot.','common','hands_won',1,50,'trophy'),
  ('ten_hands','Ten Hands Played','Play 10 hands.','common','hands_played',10,50,'layers'),
  ('hundred_hands','Hundred Hands Played','Play 100 hands.','uncommon','hands_played',100,200,'layers-3'),
  ('thousand_hands','Dedicated Player','Play 1,000 hands.','rare','hands_played',1000,1000,'flame'),
  ('first_tournament','First Tournament','Play in a tournament.','common','tournaments_played',1,100,'flag'),
  ('tournament_winner','Tournament Champion','Win a tournament.','epic','tournament_wins',1,750,'crown'),
  ('streak_5','Hot Hand','Win 5 hands in a row.','rare','best_streak',5,300,'zap'),
  ('showdown_25','Showdown Specialist','Win 25 showdowns.','uncommon','showdowns_won',25,250,'eye');

INSERT INTO quests (key, name, period, metric, target, xp_reward) VALUES
  ('daily_hands_20','Play 20 hands','daily','hands_played',20,60),
  ('daily_win_3','Win 3 pots','daily','hands_won',3,60),
  ('daily_showdown_2','Win 2 showdowns','daily','showdowns_won',2,50),
  ('weekly_hands_200','Play 200 hands','weekly','hands_played',200,400),
  ('weekly_tournament','Play a tournament','weekly','tournaments_played',1,300);

INSERT INTO items (key, name, kind, rarity, giftable, daily_send_limit, animation) VALUES
  ('rose','Rose','gift','common',true,10,'float'),
  ('champagne','Champagne Toast','gift','uncommon',true,5,'sparkle'),
  ('gold_star','Gold Star','gift','common',true,10,'pulse'),
  ('trophy','Trophy','gift','rare',true,3,'rise'),
  ('applause','Applause','emote','common',true,20,'bounce'),
  ('frame_gold','Champagne Frame','frame','rare',false,0,NULL),
  ('frame_silver','Silver Frame','frame','uncommon',false,0,NULL),
  ('back_noir','Noir Card Back','card_back','common',false,0,NULL),
  ('back_gold_filigree','Gold Filigree Card Back','card_back','epic',false,0,NULL),
  ('badge_founder','Founder Badge','badge','legendary',false,0,NULL);

INSERT INTO app_config (key, value) VALUES
  ('maintenance', '{"enabled": false, "message": ""}'),
  ('xp_rules', '{"version": 1, "handPlayed": 2, "handWon": 3, "showdownWon": 2, "dailyHandXpCap": 300, "minPotForWinXp": 0}'),
  ('chat', '{"allowLinks": false, "maxLength": 300, "perMinute": 12, "dmEnabled": true, "bannedWords": []}'),
  ('signup_bonus', '{"amount": 0}'),
  ('leaderboards', '{"enabled": ["level","xp","hands_played","hands_won","tournament_points","weekly","monthly"]}'),
  ('currency', '{"denomination": "ALL", "label": "Game credits (non-redeemable)"}');

INSERT INTO chat_channels (kind) VALUES ('lobby');
