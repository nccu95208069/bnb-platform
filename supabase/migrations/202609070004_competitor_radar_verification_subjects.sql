-- Verification events are append-only, but append-only data is only useful if
-- the referenced subject existed in the same tenant and competitor property at
-- insertion time. Derive both actor and property from authoritative tables.

create or replace function public.prepare_competitor_verification_event()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_property_id uuid;
begin
  if auth.uid() is null then
    raise exception 'authenticated actor required for competitor verification event';
  end if;

  case new.subject_type
    when 'property' then
      select property.id
      into v_property_id
      from public.competitor_property property
      where property.id = new.subject_id
        and property.tenant_id = new.tenant_id;

    when 'property_source' then
      select source.competitor_property_id
      into v_property_id
      from public.competitor_property_source source
      where source.id = new.subject_id
        and source.tenant_id = new.tenant_id;

    when 'canonical_room' then
      select room.competitor_property_id
      into v_property_id
      from public.competitor_canonical_room room
      where room.id = new.subject_id
        and room.tenant_id = new.tenant_id;

    when 'source_room' then
      select room.competitor_property_id
      into v_property_id
      from public.competitor_source_room room
      where room.id = new.subject_id
        and room.tenant_id = new.tenant_id;

    when 'room_mapping' then
      select mapping.competitor_property_id
      into v_property_id
      from public.competitor_room_mapping mapping
      where mapping.id = new.subject_id
        and mapping.tenant_id = new.tenant_id;

    else
      raise exception 'unsupported competitor verification subject type: %', new.subject_type;
  end case;

  if v_property_id is null then
    raise exception 'competitor verification subject not found in tenant';
  end if;

  if new.competitor_property_id is not null
     and new.competitor_property_id <> v_property_id then
    raise exception 'competitor verification subject belongs to another property';
  end if;

  new.competitor_property_id = v_property_id;
  new.actor_auth_user_id = auth.uid();
  return new;
end;
$$;

revoke execute on function public.prepare_competitor_verification_event()
  from public, anon, authenticated;

drop trigger if exists competitor_verification_event_set_actor
  on public.competitor_verification_event;
drop trigger if exists competitor_verification_event_prepare
  on public.competitor_verification_event;

create trigger competitor_verification_event_prepare
before insert on public.competitor_verification_event
for each row execute function public.prepare_competitor_verification_event();

drop function if exists public.set_competitor_verification_actor();
