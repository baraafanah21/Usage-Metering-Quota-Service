-- 001_init: full schema from DESIGN.md §4, verbatim.
-- Applied by src/db/migrate.ts inside one transaction.

-- Enums
CREATE TYPE plan_scope   AS ENUM ('account', 'user');
CREATE TYPE rule_type    AS ENUM ('monthly_allowance', 'max_units_per_request');
CREATE TYPE decision     AS ENUM ('accepted', 'rejected');

CREATE TABLE plans (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_account_id uuid NULL,                           -- NULL = predefined; FK added after accounts (circular reference)
  scope            plan_scope NOT NULL,
  name             text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  version          int  NOT NULL DEFAULT 1,             -- bumped on every rule change
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
-- Name unique per owner+scope; predefined names unique among themselves.
CREATE UNIQUE INDEX plans_owner_scope_name ON plans (owner_account_id, scope, lower(name)) WHERE owner_account_id IS NOT NULL;
CREATE UNIQUE INDEX plans_predefined_name  ON plans (scope, lower(name)) WHERE owner_account_id IS NULL;

CREATE TABLE plan_rules (
  plan_id  uuid      NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  type     rule_type NOT NULL,
  "limit"  bigint    NOT NULL CHECK ("limit" >= 0),
  PRIMARY KEY (plan_id, type)                            -- at most one rule of each type per plan
);

CREATE TABLE accounts (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  plan_id    uuid NOT NULL REFERENCES plans(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- plans ↔ accounts reference each other, so this FK is added once both tables exist.
ALTER TABLE plans ADD CONSTRAINT plans_owner_account_fk
  FOREIGN KEY (owner_account_id) REFERENCES accounts(id);

CREATE TABLE api_keys (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  uuid NOT NULL REFERENCES accounts(id),
  key_hash    bytea NOT NULL UNIQUE,     -- sha256(secret); plaintext never stored
  key_prefix  text  NOT NULL,            -- first chars, for display ("mk_7Fq2…")
  created_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at  timestamptz NULL
);

CREATE TABLE users (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  uuid NOT NULL REFERENCES accounts(id),
  external_id text NOT NULL CHECK (length(external_id) BETWEEN 1 AND 200),
  plan_id     uuid NOT NULL REFERENCES plans(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, external_id),
  UNIQUE (id, account_id)                -- target for composite FKs below
);

CREATE TABLE account_monthly_usage (
  account_id uuid NOT NULL REFERENCES accounts(id),
  month      date NOT NULL CHECK (extract(day FROM month) = 1),
  used       bigint NOT NULL DEFAULT 0 CHECK (used >= 0),
  PRIMARY KEY (account_id, month)
);

CREATE TABLE user_monthly_usage (
  user_id    uuid NOT NULL,
  account_id uuid NOT NULL,
  month      date NOT NULL CHECK (extract(day FROM month) = 1),
  used       bigint NOT NULL DEFAULT 0 CHECK (used >= 0),
  PRIMARY KEY (user_id, month),
  FOREIGN KEY (user_id, account_id) REFERENCES users(id, account_id)  -- user can't leak across accounts
);
CREATE INDEX user_usage_by_account_month ON user_monthly_usage (account_id, month);

CREATE TABLE usage_requests (               -- append-only ledger
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id        uuid NOT NULL,
  user_id           uuid NOT NULL,
  request_id        text NOT NULL CHECK (length(request_id) BETWEEN 1 AND 200),
  units             bigint NOT NULL CHECK (units > 0),
  decision          decision NOT NULL,
  reject_scope      plan_scope NULL,        -- 'account' | 'user' when rejected
  reject_rule       rule_type  NULL,
  month             date NOT NULL,
  account_plan_id   uuid NOT NULL, account_plan_version int NOT NULL,
  user_plan_id      uuid NOT NULL, user_plan_version    int NOT NULL,
  evaluation        jsonb NOT NULL,         -- snapshot: limits, used-before, remaining-after, all violations
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, request_id),          -- idempotency
  FOREIGN KEY (user_id, account_id) REFERENCES users(id, account_id),
  CHECK ((decision = 'accepted') = (reject_rule IS NULL AND reject_scope IS NULL))
);
CREATE INDEX usage_requests_account_hist ON usage_requests (account_id, id DESC);
CREATE INDEX usage_requests_user_hist    ON usage_requests (user_id, id DESC);
CREATE INDEX usage_requests_account_month ON usage_requests (account_id, month, id DESC);
