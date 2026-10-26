-- Apple Card isn't linked (SimpleFIN can't reach it), so its payments from
-- checking are the only record of that spending. Make sure every user has an
-- "Apple Card (unlinked)" envelope with a rule that counts those payments as
-- spending instead of hiding them as transfers. Skipped for anyone who already
-- has the rule (e.g. from the budget plan) or who imported Apple Card data.
INSERT INTO categories (user_id, name, group_name, sort_order)
SELECT u.id, 'Apple Card (unlinked)', 'Everyday', 20
FROM users u
WHERE NOT EXISTS (SELECT 1 FROM category_rules r WHERE r.user_id = u.id AND lower(r.value) = 'applecard gsbank')
  AND NOT EXISTS (SELECT 1 FROM bank_accounts b WHERE b.user_id = u.id AND b.provider = 'apple_card')
ON CONFLICT (user_id, (lower(name))) DO NOTHING;

INSERT INTO category_rules (user_id, stage, field, op, value, category_id, set_transfer, source)
SELECT c.user_id, 'post', 'any', 'contains', 'applecard gsbank', c.id, false, 'manual'
FROM categories c
WHERE c.name = 'Apple Card (unlinked)'
  AND NOT EXISTS (SELECT 1 FROM category_rules r WHERE r.user_id = c.user_id AND lower(r.value) = 'applecard gsbank')
  AND NOT EXISTS (SELECT 1 FROM bank_accounts b WHERE b.user_id = c.user_id AND b.provider = 'apple_card');

-- Re-file existing transactions with the new rule on next Budget open.
UPDATE budget_settings SET processed_at = NULL;
