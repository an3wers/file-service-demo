alter table registration_attempts add column email text;
update registration_attempts set email = users.email from users where users.id = registration_attempts.user_id;
