create table registration_attempts (
  token_hash text primary key,
  user_id uuid references users(id),
  password_hash text,
  token_version integer,
  code_hash text not null,
  expires_at timestamptz not null,
  code_expires_at timestamptz not null,
  resend_available_at timestamptz not null,
  failures integer not null default 0 check (failures between 0 and 5),
  consumed_at timestamptz,
  check (code_expires_at <= expires_at),
  check ((user_id is null) = (password_hash is null) and (user_id is null) = (token_version is null))
);
create index registration_attempts_user on registration_attempts (user_id) where user_id is not null;
