alter table users add column name text;
alter table users add column email text;
alter table users add column state text not null default 'active' check (state in ('inactive', 'active'));
alter table users add constraint users_email_unique unique (email);
alter table users add constraint users_registration_fields check (email is null or (name is not null and email = lower(btrim(email))));

create table auth_secrets (
  user_id uuid not null references users(id),
  purpose text not null check (purpose in ('activation', 'password-reset')),
  token_hash text not null unique,
  expires_at timestamptz not null,
  primary key (user_id, purpose)
);

create table auth_mail_events (
  key text not null,
  window_ms integer not null check (window_ms > 0),
  occurred_at timestamptz not null
);
create index auth_mail_events_key_time on auth_mail_events (key, window_ms, occurred_at);
