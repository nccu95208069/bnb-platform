create extension if not exists pgcrypto;

create table if not exists public.competitor_property (
  id uuid primary key default gen_random_uuid(),
  tenant_id varchar not null references public.tenant(id) on delete cascade,
  display_name text not null,
  seed_url text not null,
  official_website_url text null,
  government_hotel_id text null,
  address text null,
  normalized_address text null,
  phone text null,
  latitude double precision null,
  longitude double precision null,
  identity_status text not null default 'review',
  identity_confidence numeric(5,4) not null default 0,
  evidence jsonb not null default '[]'::jsonb,
  created_by uuid null references auth.users(id) on delete set null default auth.uid(),
  updated_by uuid null references auth.users(id) on delete set null default auth.uid(),
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint competitor_property_name_not_blank check (btrim(display_name) <> ''),
  constraint competitor_property_seed_url_not_blank check (btrim(seed_url) <> ''),
  constraint competitor_property_identity_status check (
    identity_status in ('draft', 'confirmed', 'review', 'rejected')
  ),
  constraint competitor_property_identity_confidence check (
    identity_confidence >= 0 and identity_confidence <= 1
  ),
  constraint competitor_property_evidence_array check (jsonb_typeof(evidence) = 'array'),
  constraint competitor_property_version_positive check (version > 0),
  unique (id, tenant_id)
);

create unique index if not exists ux_competitor_property_tenant_seed_url
  on public.competitor_property (tenant_id, seed_url);

create unique index if not exists ux_competitor_property_tenant_government_id
  on public.competitor_property (tenant_id, government_hotel_id)
  where government_hotel_id is not null;

create index if not exists ix_competitor_property_tenant_updated
  on public.competitor_property (tenant_id, updated_at desc);

create index if not exists ix_competitor_property_normalized_address
  on public.competitor_property (tenant_id, normalized_address)
  where normalized_address is not null;

create table if not exists public.competitor_property_source (
  id uuid primary key default gen_random_uuid(),
  competitor_property_id uuid not null,
  tenant_id varchar not null,
  platform text not null,
  source_url text not null,
  source_property_id text null,
  raw_name text null,
  raw_address text null,
  raw_phone text null,
  latitude double precision null,
  longitude double precision null,
  identity_status text not null default 'candidate',
  identity_confidence numeric(5,4) not null default 0,
  evidence jsonb not null default '[]'::jsonb,
  user_verified boolean not null default false,
  verified_by uuid null references auth.users(id) on delete set null,
  verified_at timestamptz null,
  last_fetched_at timestamptz null,
  parser_version text null,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint competitor_property_source_parent_fk
    foreign key (competitor_property_id, tenant_id)
    references public.competitor_property(id, tenant_id)
    on delete cascade,
  constraint competitor_property_source_platform check (
    platform in ('official', 'booking', 'agoda', 'trip')
  ),
  constraint competitor_property_source_identity_status check (
    identity_status in ('candidate', 'confirmed', 'review', 'rejected', 'absent', 'fetch_failed')
  ),
  constraint competitor_property_source_confidence check (
    identity_confidence >= 0 and identity_confidence <= 1
  ),
  constraint competitor_property_source_url_not_blank check (btrim(source_url) <> ''),
  constraint competitor_property_source_evidence_array check (jsonb_typeof(evidence) = 'array'),
  constraint competitor_property_source_verification_consistent check (
    not user_verified or (verified_by is not null and verified_at is not null)
  ),
  constraint competitor_property_source_version_positive check (version > 0),
  unique (id, tenant_id),
  unique (competitor_property_id, platform, source_url)
);

create unique index if not exists ux_competitor_property_source_confirmed_platform
  on public.competitor_property_source (competitor_property_id, platform)
  where identity_status = 'confirmed';

create index if not exists ix_competitor_property_source_property_platform
  on public.competitor_property_source (competitor_property_id, platform, updated_at desc);

create table if not exists public.competitor_canonical_room (
  id uuid primary key default gen_random_uuid(),
  competitor_property_id uuid not null,
  tenant_id varchar not null,
  name text not null,
  room_number text null,
  capacity integer null,
  is_bundle boolean not null default false,
  feature_keys jsonb not null default '[]'::jsonb,
  source_of_truth text not null default 'official_website',
  source_url text null,
  is_active boolean not null default true,
  created_by uuid null references auth.users(id) on delete set null default auth.uid(),
  updated_by uuid null references auth.users(id) on delete set null default auth.uid(),
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint competitor_canonical_room_parent_fk
    foreign key (competitor_property_id, tenant_id)
    references public.competitor_property(id, tenant_id)
    on delete cascade,
  constraint competitor_canonical_room_name_not_blank check (btrim(name) <> ''),
  constraint competitor_canonical_room_capacity_positive check (capacity is null or capacity > 0),
  constraint competitor_canonical_room_features_array check (jsonb_typeof(feature_keys) = 'array'),
  constraint competitor_canonical_room_source_of_truth check (
    source_of_truth in ('official_website', 'government_registry', 'ota', 'manual')
  ),
  constraint competitor_canonical_room_version_positive check (version > 0),
  unique (id, tenant_id)
);

create unique index if not exists ux_competitor_canonical_room_active_number
  on public.competitor_canonical_room (competitor_property_id, room_number)
  where room_number is not null and is_active;

create index if not exists ix_competitor_canonical_room_property_active
  on public.competitor_canonical_room (competitor_property_id, is_active, updated_at desc);

create table if not exists public.competitor_source_room (
  id uuid primary key default gen_random_uuid(),
  property_source_id uuid not null,
  tenant_id varchar not null,
  source_room_key text not null,
  source_room_id text null,
  raw_name text not null,
  capacity integer null,
  is_bundle boolean not null default false,
  feature_keys jsonb not null default '[]'::jsonb,
  raw_payload_hash text null,
  parser_version text null,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint competitor_source_room_parent_fk
    foreign key (property_source_id, tenant_id)
    references public.competitor_property_source(id, tenant_id)
    on delete cascade,
  constraint competitor_source_room_key_not_blank check (btrim(source_room_key) <> ''),
  constraint competitor_source_room_name_not_blank check (btrim(raw_name) <> ''),
  constraint competitor_source_room_capacity_positive check (capacity is null or capacity > 0),
  constraint competitor_source_room_features_array check (jsonb_typeof(feature_keys) = 'array'),
  constraint competitor_source_room_seen_order check (last_seen_at >= first_seen_at),
  constraint competitor_source_room_version_positive check (version > 0),
  unique (id, tenant_id),
  unique (property_source_id, source_room_key)
);

create index if not exists ix_competitor_source_room_source_seen
  on public.competitor_source_room (property_source_id, last_seen_at desc);

create table if not exists public.competitor_room_mapping (
  id uuid primary key default gen_random_uuid(),
  tenant_id varchar not null references public.tenant(id) on delete cascade,
  source_room_id uuid not null,
  mapping_type text not null default 'one_to_one',
  mapping_status text not null default 'proposed',
  confidence numeric(5,4) not null default 0,
  evidence jsonb not null default '[]'::jsonb,
  verified_by uuid null references auth.users(id) on delete set null,
  verified_at timestamptz null,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint competitor_room_mapping_source_fk
    foreign key (source_room_id, tenant_id)
    references public.competitor_source_room(id, tenant_id)
    on delete cascade,
  constraint competitor_room_mapping_type check (
    mapping_type in ('one_to_one', 'one_to_many_offers', 'pooled_room_type', 'bundle', 'unmapped')
  ),
  constraint competitor_room_mapping_status check (
    mapping_status in ('proposed', 'user_confirmed', 'rejected')
  ),
  constraint competitor_room_mapping_confidence check (confidence >= 0 and confidence <= 1),
  constraint competitor_room_mapping_evidence_array check (jsonb_typeof(evidence) = 'array'),
  constraint competitor_room_mapping_verification_consistent check (
    mapping_status <> 'user_confirmed' or (verified_by is not null and verified_at is not null)
  ),
  constraint competitor_room_mapping_version_positive check (version > 0),
  unique (id, tenant_id),
  unique (source_room_id)
);

create index if not exists ix_competitor_room_mapping_tenant_status
  on public.competitor_room_mapping (tenant_id, mapping_status, updated_at desc);

create table if not exists public.competitor_room_mapping_target (
  mapping_id uuid not null,
  canonical_room_id uuid not null,
  tenant_id varchar not null,
  component_quantity integer not null default 1,
  created_at timestamptz not null default now(),
  primary key (mapping_id, canonical_room_id),
  constraint competitor_room_mapping_target_mapping_fk
    foreign key (mapping_id, tenant_id)
    references public.competitor_room_mapping(id, tenant_id)
    on delete cascade,
  constraint competitor_room_mapping_target_room_fk
    foreign key (canonical_room_id, tenant_id)
    references public.competitor_canonical_room(id, tenant_id)
    on delete cascade,
  constraint competitor_room_mapping_target_quantity_positive check (component_quantity > 0)
);

create index if not exists ix_competitor_room_mapping_target_room
  on public.competitor_room_mapping_target (canonical_room_id);

create table if not exists public.competitor_verification_event (
  id uuid primary key default gen_random_uuid(),
  tenant_id varchar not null references public.tenant(id) on delete cascade,
  competitor_property_id uuid null,
  subject_type text not null,
  subject_id uuid not null,
  action text not null,
  before_state jsonb null,
  after_state jsonb null,
  evidence jsonb not null default '[]'::jsonb,
  actor_auth_user_id uuid null references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  constraint competitor_verification_event_property_fk
    foreign key (competitor_property_id, tenant_id)
    references public.competitor_property(id, tenant_id)
    on delete cascade,
  constraint competitor_verification_event_subject_type check (
    subject_type in ('property', 'property_source', 'canonical_room', 'source_room', 'room_mapping')
  ),
  constraint competitor_verification_event_action check (
    action in ('created', 'confirmed', 'rejected', 'edited', 'remapped', 'marked_absent')
  ),
  constraint competitor_verification_event_evidence_array check (jsonb_typeof(evidence) = 'array')
);

create index if not exists ix_competitor_verification_event_tenant_created
  on public.competitor_verification_event (tenant_id, created_at desc);

create index if not exists ix_competitor_verification_event_subject
  on public.competitor_verification_event (subject_type, subject_id, created_at desc);

create or replace function public.set_competitor_radar_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at = now();
  new.version = old.version + 1;
  new.updated_by = case
    when to_jsonb(new) ? 'updated_by' then coalesce(auth.uid(), new.updated_by)
    else null
  end;
  return new;
end;
$$;

-- The generic trigger above cannot safely assign a column that is absent from
-- every table. Use a second trigger for records without updated_by.
create or replace function public.set_competitor_radar_system_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at = now();
  new.version = old.version + 1;
  return new;
end;
$$;

revoke execute on function public.set_competitor_radar_updated_at() from public, anon, authenticated;
revoke execute on function public.set_competitor_radar_system_updated_at() from public, anon, authenticated;

-- Property and canonical-room edits retain the actor who made the latest change.
drop trigger if exists competitor_property_set_updated_at on public.competitor_property;
create trigger competitor_property_set_updated_at
before update on public.competitor_property
for each row execute function public.set_competitor_radar_updated_at();

drop trigger if exists competitor_canonical_room_set_updated_at on public.competitor_canonical_room;
create trigger competitor_canonical_room_set_updated_at
before update on public.competitor_canonical_room
for each row execute function public.set_competitor_radar_updated_at();

-- Other mutable identity-graph records only need version and timestamp updates.
drop trigger if exists competitor_property_source_set_updated_at on public.competitor_property_source;
create trigger competitor_property_source_set_updated_at
before update on public.competitor_property_source
for each row execute function public.set_competitor_radar_system_updated_at();

drop trigger if exists competitor_source_room_set_updated_at on public.competitor_source_room;
create trigger competitor_source_room_set_updated_at
before update on public.competitor_source_room
for each row execute function public.set_competitor_radar_system_updated_at();

drop trigger if exists competitor_room_mapping_set_updated_at on public.competitor_room_mapping;
create trigger competitor_room_mapping_set_updated_at
before update on public.competitor_room_mapping
for each row execute function public.set_competitor_radar_system_updated_at();

create or replace function public.competitor_radar_can_read(p_tenant_id varchar)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select exists (
    select 1
    from public.workspace_member wm
    where wm.tenant_id = p_tenant_id
      and wm.auth_user_id = auth.uid()
      and wm.status = 'active'
      and wm.role <> 'viewer_no_price'
  );
$$;

create or replace function public.competitor_radar_can_manage(p_tenant_id varchar)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select exists (
    select 1
    from public.workspace_member wm
    where wm.tenant_id = p_tenant_id
      and wm.auth_user_id = auth.uid()
      and wm.status = 'active'
      and wm.role in ('owner', 'admin')
  );
$$;

revoke execute on function public.competitor_radar_can_read(varchar) from public, anon;
revoke execute on function public.competitor_radar_can_manage(varchar) from public, anon;
grant execute on function public.competitor_radar_can_read(varchar) to authenticated;
grant execute on function public.competitor_radar_can_manage(varchar) to authenticated;

alter table public.competitor_property enable row level security;
alter table public.competitor_property_source enable row level security;
alter table public.competitor_canonical_room enable row level security;
alter table public.competitor_source_room enable row level security;
alter table public.competitor_room_mapping enable row level security;
alter table public.competitor_room_mapping_target enable row level security;
alter table public.competitor_verification_event enable row level security;

revoke all on table public.competitor_property from anon, authenticated;
revoke all on table public.competitor_property_source from anon, authenticated;
revoke all on table public.competitor_canonical_room from anon, authenticated;
revoke all on table public.competitor_source_room from anon, authenticated;
revoke all on table public.competitor_room_mapping from anon, authenticated;
revoke all on table public.competitor_room_mapping_target from anon, authenticated;
revoke all on table public.competitor_verification_event from anon, authenticated;

grant select, insert, update, delete on table public.competitor_property to authenticated;
grant select, insert, update, delete on table public.competitor_property_source to authenticated;
grant select, insert, update, delete on table public.competitor_canonical_room to authenticated;
grant select, insert, update, delete on table public.competitor_source_room to authenticated;
grant select, insert, update, delete on table public.competitor_room_mapping to authenticated;
grant select, insert, update, delete on table public.competitor_room_mapping_target to authenticated;
grant select, insert on table public.competitor_verification_event to authenticated;

-- Every identity-graph table follows the same read/manage boundary. Read access
-- requires an active workspace membership with price visibility. Mutation
-- requires owner/admin and is checked both before and after UPDATE.
do $$
declare
  v_table text;
begin
  foreach v_table in array array[
    'competitor_property',
    'competitor_property_source',
    'competitor_canonical_room',
    'competitor_source_room',
    'competitor_room_mapping',
    'competitor_room_mapping_target',
    'competitor_verification_event'
  ]
  loop
    execute format('drop policy if exists %I on public.%I', v_table || '_select', v_table);
    execute format(
      'create policy %I on public.%I for select to authenticated using (public.competitor_radar_can_read(tenant_id))',
      v_table || '_select',
      v_table
    );

    execute format('drop policy if exists %I on public.%I', v_table || '_insert', v_table);
    execute format(
      'create policy %I on public.%I for insert to authenticated with check (public.competitor_radar_can_manage(tenant_id))',
      v_table || '_insert',
      v_table
    );
  end loop;
end $$;

-- Audit events are append-only through the client role.
do $$
declare
  v_table text;
begin
  foreach v_table in array array[
    'competitor_property',
    'competitor_property_source',
    'competitor_canonical_room',
    'competitor_source_room',
    'competitor_room_mapping',
    'competitor_room_mapping_target'
  ]
  loop
    execute format('drop policy if exists %I on public.%I', v_table || '_update', v_table);
    execute format(
      'create policy %I on public.%I for update to authenticated using (public.competitor_radar_can_manage(tenant_id)) with check (public.competitor_radar_can_manage(tenant_id))',
      v_table || '_update',
      v_table
    );

    execute format('drop policy if exists %I on public.%I', v_table || '_delete', v_table);
    execute format(
      'create policy %I on public.%I for delete to authenticated using (public.competitor_radar_can_manage(tenant_id))',
      v_table || '_delete',
      v_table
    );
  end loop;
end $$;
