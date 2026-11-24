-- SmartNote live refresh signals.
-- Broadcast only a minimal invalidation event; clients reload protected data through smartnote-auth.
-- Topics are public, so never include row contents, names, message bodies, or other private data.

create or replace function public.smartnote_realtime_broadcast()
returns trigger
language plpgsql
security definer
set search_path = public, realtime, pg_temp
as $$
declare
  v_users uuid[] := array[]::uuid[];
  v_assignment_id uuid;
  v_user_id uuid;
  v_topic text;
  v_session record;
begin
  if tg_table_name = 'profiles' then
    if tg_op = 'DELETE' then
      v_users := array[old.id];
    else
      v_users := array[new.id];
    end if;
  elsif tg_table_name = 'assignments' then
    if tg_op = 'DELETE' then
      v_users := array[old.created_by, old.owner_leader_id, old.assignee_id];
    elsif tg_op = 'INSERT' then
      v_users := array[new.created_by, new.owner_leader_id, new.assignee_id];
    else
      v_users := array[
        new.created_by, new.owner_leader_id, new.assignee_id,
        old.created_by, old.owner_leader_id, old.assignee_id
      ];
    end if;
  elsif tg_table_name in ('assignment_activity', 'assignment_notes', 'reassignment_requests') then
    if tg_op = 'DELETE' then
      v_assignment_id := old.assignment_id;
    else
      v_assignment_id := new.assignment_id;
    end if;
    select array_agg(distinct participant_id)
      into v_users
      from (
        select created_by as participant_id from public.assignments where id = v_assignment_id
        union all
        select owner_leader_id from public.assignments where id = v_assignment_id
        union all
        select assignee_id from public.assignments where id = v_assignment_id
      ) participants
      where participant_id is not null;
  else
    if tg_op = 'DELETE' then
      v_users := array[old.user_id];
    else
      v_users := array[new.user_id];
    end if;
  end if;

  foreach v_user_id in array coalesce(v_users, array[]::uuid[]) loop
    if v_user_id is not null then
      -- Send only to active sessions for this user. The topic is derived from
      -- the session token hash, so another user's channel name is not guessable.
      for v_session in
        select token_hash
        from public.auth_sessions
        where user_id = v_user_id
          and revoked_at is null
          and expires_at > now()
      loop
        v_topic := 'smartnote-session:' || v_session.token_hash;
        perform realtime.send(
          jsonb_build_object(
            'table', tg_table_name,
            'operation', tg_op,
            'changedAt', clock_timestamp()
          ),
          'refresh',
          v_topic,
          false
        );
      end loop;
    end if;
  end loop;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

revoke all on function public.smartnote_realtime_broadcast() from public, anon, authenticated;

drop trigger if exists smartnote_realtime_assignments on public.assignments;
create trigger smartnote_realtime_assignments after insert or update or delete on public.assignments
for each row execute function public.smartnote_realtime_broadcast();

drop trigger if exists smartnote_realtime_assignment_activity on public.assignment_activity;
create trigger smartnote_realtime_assignment_activity after insert or update or delete on public.assignment_activity
for each row execute function public.smartnote_realtime_broadcast();

drop trigger if exists smartnote_realtime_assignment_notes on public.assignment_notes;
create trigger smartnote_realtime_assignment_notes after insert or update or delete on public.assignment_notes
for each row execute function public.smartnote_realtime_broadcast();

drop trigger if exists smartnote_realtime_reassignment_requests on public.reassignment_requests;
create trigger smartnote_realtime_reassignment_requests after insert or update or delete on public.reassignment_requests
for each row execute function public.smartnote_realtime_broadcast();

drop trigger if exists smartnote_realtime_notifications on public.notifications;
create trigger smartnote_realtime_notifications after insert or update or delete on public.notifications
for each row execute function public.smartnote_realtime_broadcast();

drop trigger if exists smartnote_realtime_profiles on public.profiles;
create trigger smartnote_realtime_profiles after insert or update or delete on public.profiles
for each row execute function public.smartnote_realtime_broadcast();

-- The notebook is replaced atomically; one metadata update is enough to notify all sessions.
drop trigger if exists smartnote_realtime_database_meta on public.user_database_meta;
create trigger smartnote_realtime_database_meta after insert or update on public.user_database_meta
for each row execute function public.smartnote_realtime_broadcast();
