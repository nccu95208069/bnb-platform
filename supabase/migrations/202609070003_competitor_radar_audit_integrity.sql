-- Verification history must remain trustworthy even though Owner/Admin clients
-- may append events directly under RLS.

create or replace function public.set_competitor_verification_actor()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'authenticated actor required for competitor verification event';
  end if;

  new.actor_auth_user_id = auth.uid();
  return new;
end;
$$;

revoke execute on function public.set_competitor_verification_actor()
  from public, anon, authenticated;

drop trigger if exists competitor_verification_event_set_actor
  on public.competitor_verification_event;
create trigger competitor_verification_event_set_actor
before insert on public.competitor_verification_event
for each row execute function public.set_competitor_verification_actor();

-- Preserve append-only history when the mutable property graph is deleted.
-- Only competitor_property_id is cleared; tenant_id remains so RLS and audit
-- ownership continue to work.
alter table public.competitor_verification_event
  drop constraint if exists competitor_verification_event_property_fk;

alter table public.competitor_verification_event
  add constraint competitor_verification_event_property_fk
    foreign key (competitor_property_id, tenant_id)
    references public.competitor_property(id, tenant_id)
    on delete set null (competitor_property_id);
