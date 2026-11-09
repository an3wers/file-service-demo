delete from auth_secrets where purpose = 'activation';
alter table auth_secrets drop constraint auth_secrets_purpose_check;
alter table auth_secrets add constraint auth_secrets_purpose_check check (purpose = 'password-reset');
