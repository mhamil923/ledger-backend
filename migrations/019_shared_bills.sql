-- Shared bills: part of a bill is paid back by someone else (e.g. splitting
-- rent). The bill keeps its full amount (that's what gets charged), but the
-- budget plans only your share, and their payment is filed under the same
-- category so "Spent" shows what you actually paid.
ALTER TABLE bills ADD COLUMN IF NOT EXISTS shared_share numeric(5,4) NOT NULL DEFAULT 0
  CHECK (shared_share >= 0 AND shared_share < 1);
ALTER TABLE bills ADD COLUMN IF NOT EXISTS shared_with text;

-- Rent is split 50/50 with Madeline, who pays her half by Zelle.
UPDATE bills b SET shared_share = 0.5, shared_with = 'Madeline'
FROM categories c
WHERE c.id = b.category_id AND lower(c.name) = 'rent + utilities' AND b.shared_share = 0;

-- Her rent Zelles (≥ $400) go to Rent + utilities; smaller ones stay in Zelle & Venmo.
INSERT INTO category_rules (user_id, stage, field, op, value, amount_min, category_id, source)
SELECT c.user_id, 'pre', 'description', 'contains', 'zelle payment from madeline hezlett', 400, c.id, 'manual'
FROM categories c
WHERE lower(c.name) = 'rent + utilities'
  AND NOT EXISTS (
    SELECT 1 FROM category_rules r
    WHERE r.user_id = c.user_id AND r.value = 'zelle payment from madeline hezlett' AND r.category_id = c.id
  );

-- Re-file the ones already imported (never touching anything set by hand).
UPDATE transactions t SET category_id = c.id, category_source = 'rule', is_transfer = false,
  transfer_source = NULL, transfer_txn_id = NULL
FROM categories c
WHERE c.user_id = t.user_id AND lower(c.name) = 'rent + utilities'
  AND t.amount >= 400 AND t.description ILIKE 'zelle payment from madeline hezlett%'
  AND t.category_source IS DISTINCT FROM 'manual';

-- Plan only your half of rent from the budget's start month on.
UPDATE category_budgets cb SET budgeted = round(cb.budgeted * 0.5, 2), updated_at = now()
FROM categories c
LEFT JOIN budget_settings s ON s.user_id = c.user_id
WHERE cb.category_id = c.id AND lower(c.name) = 'rent + utilities' AND cb.budgeted > 0
  AND cb.month >= COALESCE(s.start_month, '0000-00');
