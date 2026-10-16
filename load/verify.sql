-- Invariant checks after a load run (DESIGN.md §11.2), over the WHOLE database, every month.
-- Any violation RAISEs, so psql exits non-zero (with ON_ERROR_STOP) and run.sh fails loudly.
--
--   docker compose exec -T db psql -U metering -d metering -v ON_ERROR_STOP=1 -f - < load/verify.sql
--
-- Optional, for one scenario's account (load/run.sh passes them from the setup file):
--   -v account_id=<uuid> -v expect_accepted_units=<n> -v expect_ledger_rows=<n>
--
-- Checks:
--   I5  every account and user counter == SUM(units) of its accepted ledger rows, per month
--   I6  every account counter == SUM of its users' counters, per month
--   A   no counter above its plan's monthly allowance, where every accepted row that month was
--       evaluated against the plan version assigned now (plan unchanged, e.g. exhaust)
--   S   every accepted ledger row satisfies the limits stored in its own evaluation snapshot,
--       and the snapshot names the plan versions the row records (plan-flip)
--   E   the scenario account has exactly the expected accepted units and ledger rows
--       (exhaust: 10,000 units; retry-storm: one row per requestId)

\set QUIET on
\if :{?account_id}
SELECT set_config('verify.account_id', :'account_id', false),
       set_config('verify.expect_accepted_units', :'expect_accepted_units', false),
       set_config('verify.expect_ledger_rows', :'expect_ledger_rows', false) \g /dev/null
\endif
\set QUIET off

DO $verify$
DECLARE
  n           bigint;
  example     text;
  n_rows      bigint;
  n_accounts  bigint;
  n_users     bigint;
  n_snapshots bigint;
  scenario_account uuid := nullif(current_setting('verify.account_id', true), '')::uuid;
  got_units   bigint;
  got_rows    bigint;
BEGIN
  -- I5, accounts. FULL JOIN: a counter without ledger rows, or accepted rows without a
  -- counter, are both violations.
  SELECT count(*), min(format('account %s month %s: counter %s, ledger %s', k.account_id, k.month, k.used, k.total))
    INTO n, example
  FROM (
    SELECT coalesce(c.account_id, l.account_id) AS account_id, coalesce(c.month, l.month) AS month,
           coalesce(c.used, 0) AS used, coalesce(l.total, 0) AS total
    FROM account_monthly_usage c
    FULL JOIN (SELECT r.account_id, r.month, sum(r.units) AS total FROM usage_requests r
               WHERE r.decision = 'accepted' GROUP BY r.account_id, r.month) l
      ON l.account_id = c.account_id AND l.month = c.month
  ) k
  WHERE k.used <> k.total;
  IF n > 0 THEN
    RAISE EXCEPTION 'I5 FAILED: % account-month counter(s) differ from their accepted ledger units', n
      USING DETAIL = 'first: ' || example;
  END IF;

  -- I5, users.
  SELECT count(*), min(format('user %s month %s: counter %s, ledger %s', k.user_id, k.month, k.used, k.total))
    INTO n, example
  FROM (
    SELECT coalesce(c.user_id, l.user_id) AS user_id, coalesce(c.month, l.month) AS month,
           coalesce(c.used, 0) AS used, coalesce(l.total, 0) AS total
    FROM user_monthly_usage c
    FULL JOIN (SELECT r.user_id, r.month, sum(r.units) AS total FROM usage_requests r
               WHERE r.decision = 'accepted' GROUP BY r.user_id, r.month) l
      ON l.user_id = c.user_id AND l.month = c.month
  ) k
  WHERE k.used <> k.total;
  IF n > 0 THEN
    RAISE EXCEPTION 'I5 FAILED: % user-month counter(s) differ from their accepted ledger units', n
      USING DETAIL = 'first: ' || example;
  END IF;

  -- I6: account counter == Σ its users' counters, per month.
  SELECT count(*), min(format('account %s month %s: account %s, users %s', k.account_id, k.month, k.used, k.users_total))
    INTO n, example
  FROM (
    SELECT coalesce(a.account_id, u.account_id) AS account_id, coalesce(a.month, u.month) AS month,
           coalesce(a.used, 0) AS used, coalesce(u.total, 0) AS users_total
    FROM account_monthly_usage a
    FULL JOIN (SELECT c.account_id, c.month, sum(c.used) AS total FROM user_monthly_usage c
               GROUP BY c.account_id, c.month) u
      ON u.account_id = a.account_id AND u.month = a.month
  ) k
  WHERE k.used <> k.users_total;
  IF n > 0 THEN
    RAISE EXCEPTION 'I6 FAILED: % account-month counter(s) differ from the sum of their users'' counters', n
      USING DETAIL = 'first: ' || example;
  END IF;

  -- A, accounts: plan unchanged that month (every accepted row on the current plan id and
  -- version) → the counter can't exceed the current monthly allowance.
  SELECT count(*), min(format('account %s month %s: used %s > allowance %s', c.account_id, c.month, c.used, pr."limit"))
    INTO n, example
  FROM account_monthly_usage c
  JOIN accounts a ON a.id = c.account_id
  JOIN plans p ON p.id = a.plan_id
  JOIN plan_rules pr ON pr.plan_id = p.id AND pr.type = 'monthly_allowance'
  WHERE c.used > pr."limit"
    AND NOT EXISTS (SELECT 1 FROM usage_requests r
                    WHERE r.account_id = c.account_id AND r.month = c.month AND r.decision = 'accepted'
                      AND (r.account_plan_id, r.account_plan_version) IS DISTINCT FROM (p.id, p.version));
  IF n > 0 THEN
    RAISE EXCEPTION 'ALLOWANCE FAILED: % account counter(s) above an unchanged plan''s monthly allowance', n
      USING DETAIL = 'first: ' || example;
  END IF;

  -- A, users.
  SELECT count(*), min(format('user %s month %s: used %s > allowance %s', c.user_id, c.month, c.used, pr."limit"))
    INTO n, example
  FROM user_monthly_usage c
  JOIN users u ON u.id = c.user_id
  JOIN plans p ON p.id = u.plan_id
  JOIN plan_rules pr ON pr.plan_id = p.id AND pr.type = 'monthly_allowance'
  WHERE c.used > pr."limit"
    AND NOT EXISTS (SELECT 1 FROM usage_requests r
                    WHERE r.user_id = c.user_id AND r.month = c.month AND r.decision = 'accepted'
                      AND (r.user_plan_id, r.user_plan_version) IS DISTINCT FROM (p.id, p.version));
  IF n > 0 THEN
    RAISE EXCEPTION 'ALLOWANCE FAILED: % user counter(s) above an unchanged plan''s monthly allowance', n
      USING DETAIL = 'first: ' || example;
  END IF;

  -- S: each accepted row against its own snapshot (the §6.1 response stored at decision
  -- time). used is after the increment, so used <= allowance means the request fit. A null
  -- limit is no rule (unlimited). Rows without a snapshot response (none written by the
  -- API) are skipped.
  SELECT count(*), min(format('ledger row %s (request %s): %s', r.id, r.request_id, r.evaluation::text))
    INTO n, example
  FROM usage_requests r
  CROSS JOIN LATERAL (SELECT r.evaluation -> 'account' AS a, r.evaluation -> 'user' AS u) s
  WHERE r.decision = 'accepted' AND s.a IS NOT NULL AND s.u IS NOT NULL
    AND NOT (
          r.evaluation ->> 'decision' = 'accepted'
      AND (r.evaluation ->> 'units')::bigint = r.units
      AND (s.a ->> 'planId')::uuid = r.account_plan_id AND (s.a ->> 'planVersion')::int = r.account_plan_version
      AND (s.u ->> 'planId')::uuid = r.user_plan_id    AND (s.u ->> 'planVersion')::int = r.user_plan_version
      AND r.units <= coalesce((s.a ->> 'maxUnitsPerRequest')::bigint, r.units)
      AND r.units <= coalesce((s.u ->> 'maxUnitsPerRequest')::bigint, r.units)
      AND (s.a ->> 'used')::bigint <= coalesce((s.a ->> 'monthlyAllowance')::bigint, (s.a ->> 'used')::bigint)
      AND (s.u ->> 'used')::bigint <= coalesce((s.u ->> 'monthlyAllowance')::bigint, (s.u ->> 'used')::bigint)
    );
  IF n > 0 THEN
    RAISE EXCEPTION 'SNAPSHOT FAILED: % accepted ledger row(s) break the limits in their own evaluation snapshot', n
      USING DETAIL = 'first: ' || example;
  END IF;

  -- E: the scenario's exact expectations, when given.
  IF scenario_account IS NOT NULL THEN
    SELECT coalesce(sum(r.units) FILTER (WHERE r.decision = 'accepted'), 0), count(*)
      INTO got_units, got_rows
    FROM usage_requests r WHERE r.account_id = scenario_account;
    IF got_units <> current_setting('verify.expect_accepted_units')::bigint
       OR got_rows <> current_setting('verify.expect_ledger_rows')::bigint THEN
      RAISE EXCEPTION 'EXPECTED FAILED: account % has % accepted units in % ledger rows; expected % units in % rows',
        scenario_account, got_units, got_rows,
        current_setting('verify.expect_accepted_units'), current_setting('verify.expect_ledger_rows');
    END IF;
  END IF;

  SELECT count(*) INTO n_rows FROM usage_requests;
  SELECT count(*) INTO n_accounts FROM account_monthly_usage;
  SELECT count(*) INTO n_users FROM user_monthly_usage;
  SELECT count(*) INTO n_snapshots FROM usage_requests r
    WHERE r.decision = 'accepted' AND r.evaluation ? 'account' AND r.evaluation ? 'user';
  RAISE NOTICE 'verify OK: I5 + I6 + allowance over % account and % user counters, % ledger rows, % accepted snapshots%',
    n_accounts, n_users, n_rows, n_snapshots,
    CASE WHEN scenario_account IS NULL THEN ''
         ELSE format('; expected %s units in %s rows: exact', got_units, got_rows) END;
END
$verify$;
