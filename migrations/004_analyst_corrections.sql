-- Analysts can suspend a key directly, and correct a decision wrongly marked
-- legitimate to takeover. Both are audited like every other analyst action.
alter table analyst_actions drop constraint analyst_actions_action_check;
alter table analyst_actions add constraint analyst_actions_action_check check (action in
  ('confirm_takeover','mark_legitimate','release_hold','unblock_key',
   'owner_this_was_me','owner_not_me','suspend_key','correct_to_takeover'));
