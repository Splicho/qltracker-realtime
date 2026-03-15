create table if not exists public.server_snapshots (
  addr text primary key,
  payload jsonb not null,
  updated_at timestamptz not null default now()
);

create index if not exists server_snapshots_updated_at_idx
  on public.server_snapshots (updated_at desc);
