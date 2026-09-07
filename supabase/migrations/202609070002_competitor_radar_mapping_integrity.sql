-- Keep every source-room mapping inside one competitor property. Tenant-only
-- foreign keys are insufficient because two competitor properties can share a
-- tenant; without these composite keys a source room from property A could be
-- mapped to a canonical room from property B.

alter table public.competitor_property_source
  add constraint competitor_property_source_property_identity_unique
  unique (id, competitor_property_id, tenant_id);

alter table public.competitor_canonical_room
  add constraint competitor_canonical_room_property_identity_unique
  unique (id, competitor_property_id, tenant_id);

alter table public.competitor_source_room
  add column competitor_property_id uuid null;

update public.competitor_source_room source_room
set competitor_property_id = property_source.competitor_property_id
from public.competitor_property_source property_source
where property_source.id = source_room.property_source_id
  and property_source.tenant_id = source_room.tenant_id;

alter table public.competitor_source_room
  alter column competitor_property_id set not null,
  add constraint competitor_source_room_property_source_fk
    foreign key (property_source_id, competitor_property_id, tenant_id)
    references public.competitor_property_source(id, competitor_property_id, tenant_id)
    on delete cascade,
  add constraint competitor_source_room_property_identity_unique
    unique (id, competitor_property_id, tenant_id);

alter table public.competitor_room_mapping
  add column competitor_property_id uuid null;

update public.competitor_room_mapping mapping
set competitor_property_id = source_room.competitor_property_id
from public.competitor_source_room source_room
where source_room.id = mapping.source_room_id
  and source_room.tenant_id = mapping.tenant_id;

alter table public.competitor_room_mapping
  alter column competitor_property_id set not null,
  add constraint competitor_room_mapping_source_property_fk
    foreign key (source_room_id, competitor_property_id, tenant_id)
    references public.competitor_source_room(id, competitor_property_id, tenant_id)
    on delete cascade,
  add constraint competitor_room_mapping_property_identity_unique
    unique (id, competitor_property_id, tenant_id);

alter table public.competitor_room_mapping_target
  add column competitor_property_id uuid null;

update public.competitor_room_mapping_target target
set competitor_property_id = mapping.competitor_property_id
from public.competitor_room_mapping mapping
where mapping.id = target.mapping_id
  and mapping.tenant_id = target.tenant_id;

alter table public.competitor_room_mapping_target
  alter column competitor_property_id set not null,
  add constraint competitor_room_mapping_target_mapping_property_fk
    foreign key (mapping_id, competitor_property_id, tenant_id)
    references public.competitor_room_mapping(id, competitor_property_id, tenant_id)
    on delete cascade,
  add constraint competitor_room_mapping_target_room_property_fk
    foreign key (canonical_room_id, competitor_property_id, tenant_id)
    references public.competitor_canonical_room(id, competitor_property_id, tenant_id)
    on delete cascade;

create index if not exists ix_competitor_source_room_property
  on public.competitor_source_room (competitor_property_id, last_seen_at desc);

create index if not exists ix_competitor_room_mapping_property
  on public.competitor_room_mapping (competitor_property_id, mapping_status, updated_at desc);
