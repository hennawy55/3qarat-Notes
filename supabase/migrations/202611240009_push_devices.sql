create table if not exists public.push_devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  fcm_token text not null unique,
  platform text not null default 'android' check (platform in ('android')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists push_devices_user_id_idx on public.push_devices(user_id);
alter table public.push_devices enable row level security;
