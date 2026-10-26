-- Storage migration foundation. Tokens are encrypted by the server before persistence.
create extension if not exists pgcrypto;

create type public.migration_status as enum (
  'queued','scanning','copying','verifying','verified','delete_pending','deleted','failed','cancelled'
);

create table public.google_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('source','destination')),
  google_subject text not null,
  email text not null,
  scopes text[] not null default '{}',
  encrypted_refresh_token bytea,
  token_key_version text,
  connected_at timestamptz not null default now(),
  revoked_at timestamptz,
  unique(user_id, role)
);

create table public.migration_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  mode text not null check (mode in ('photos_videos','videos_only','drive','all','largest')),
  status public.migration_status not null default 'queued',
  total_bytes bigint not null default 0 check (total_bytes >= 0),
  processed_bytes bigint not null default 0 check (processed_bytes >= 0),
  verified_bytes bigint not null default 0 check (verified_bytes >= 0),
  error_message text,
  delete_confirmation_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.migration_files (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.migration_jobs(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  source_service text not null check (source_service in ('drive','photos')),
  source_file_id text not null,
  destination_file_id text,
  file_name text not null,
  mime_type text,
  size_bytes bigint not null default 0 check (size_bytes >= 0),
  source_md5 text,
  source_sha256 text,
  destination_md5 text,
  destination_sha256 text,
  status public.migration_status not null default 'queued',
  selected_for_migration boolean not null default true,
  verified_at timestamptz,
  delete_requested_at timestamptz,
  deleted_at timestamptz,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(job_id, source_service, source_file_id)
);

create index migration_jobs_user_created_idx on public.migration_jobs(user_id, created_at desc);
create index migration_files_job_status_idx on public.migration_files(job_id, status);
create index migration_files_largest_idx on public.migration_files(job_id, size_bytes desc);

alter table public.google_connections enable row level security;
alter table public.migration_jobs enable row level security;
alter table public.migration_files enable row level security;

create policy "users manage own google connections" on public.google_connections
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "users manage own migration jobs" on public.migration_jobs
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "users manage own migration files" on public.migration_files
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Never expose refresh tokens to browser clients. Store only envelope-encrypted tokens
-- from a trusted backend; do not place the encryption key in this database.
revoke all on public.google_connections from anon, authenticated;
grant select, insert, update, delete on public.google_connections to authenticated;
