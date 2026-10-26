-- Dexter Google Lleno: dual OAuth and transfer audit tables.
-- Keep all names namespaced because this Supabase project is shared with the veterinary app.
alter table public.dexter_google_oauth_secrets
  alter column encrypted_refresh_token type text
  using convert_from(encrypted_refresh_token, 'UTF8');

create table if not exists public.dexter_google_credentials (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  account_role text not null check (account_role in ('account_source','account_target')),
  google_subject text not null,
  email text not null,
  scopes text[] not null default '{}',
  encrypted_refresh_token text not null,
  encryption_version text not null default 'aes-256-gcm-v1',
  connected_at timestamptz not null default now(),
  revoked_at timestamptz,
  updated_at timestamptz not null default now(),
  unique(user_id, account_role)
);
alter table public.dexter_google_credentials enable row level security;
revoke all on public.dexter_google_credentials from anon, authenticated;

create table if not exists public.dexter_google_transfer_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  job_id uuid not null references public.dexter_google_migration_jobs(id) on delete cascade,
  file_id text not null,
  source_service text not null check (source_service in ('drive','photos')),
  destination_file_id text,
  status text not null check (status in ('queued','copying','copied','verifying','verified','delete_pending','deleted','failed')),
  source_size_bytes bigint,
  destination_size_bytes bigint,
  source_checksum text,
  destination_checksum text,
  attempts integer not null default 0,
  error_code text,
  error_message text,
  copied_at timestamptz,
  verified_at timestamptz,
  delete_confirmed_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(job_id, source_service, file_id)
);
create index if not exists dexter_google_transfer_logs_job_status_idx on public.dexter_google_transfer_logs(job_id,status);
create index if not exists dexter_google_transfer_logs_user_idx on public.dexter_google_transfer_logs(user_id,created_at desc);
alter table public.dexter_google_transfer_logs enable row level security;
drop policy if exists "users read own transfer logs" on public.dexter_google_transfer_logs;
create policy "users read own transfer logs" on public.dexter_google_transfer_logs for select to authenticated using (auth.uid()=user_id);
revoke insert,update,delete on public.dexter_google_transfer_logs from anon,authenticated;
grant select on public.dexter_google_transfer_logs to authenticated;
