-- End of the plan time bought at the full price: included AI spend while allowance_until > now.
-- Full-price time goes first, own-key time after it, so an own-key renewal keeps the already paid allowance.
ALTER TABLE users ADD COLUMN allowance_until INTEGER;
UPDATE users SET allowance_until = paid_until WHERE plan_byok = 0;
