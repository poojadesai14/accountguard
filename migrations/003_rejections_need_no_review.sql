-- A send rejected because its key was already suspended (reason key_suspended)
-- no longer opens a review: the suspension and its triggering decision are the
-- case. Close the ones opened before that rule.
update decisions set review_status = 'none'
where reason = 'key_suspended' and review_status = 'open';
