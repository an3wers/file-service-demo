create table if not exists users (
  id            uuid        primary key,
  login         text        not null,
  password_hash text        not null,
  token_version integer     not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint users_login_uniq unique (login)
);
