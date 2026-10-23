-- When the bank's numbers are actually from (SimpleFIN's balance-date), as
-- opposed to when we last asked. SimpleFIN refreshes from banks about once a
-- day, so this is usually hours behind "synced just now".
ALTER TABLE bank_accounts ADD COLUMN balance_as_of timestamptz;
