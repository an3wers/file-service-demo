create table login_attempts (
  token_hash text primary key,
  user_id uuid not null references users(id),
  token_version integer not null,
  code_hash text not null,
  expires_at timestamptz not null,
  code_expires_at timestamptz not null,
  resend_available_at timestamptz not null,
  failures integer not null default 0 check (failures between 0 and 5),
  consumed_at timestamptz,
  check (code_expires_at <= expires_at)
);
create index login_attempts_user on login_attempts (user_id);

create table auth_sessions (
  token_hash text primary key,
  user_id uuid not null references users(id),
  created_at timestamptz not null,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  check (expires_at > created_at)
);
create index auth_sessions_user on auth_sessions (user_id);
