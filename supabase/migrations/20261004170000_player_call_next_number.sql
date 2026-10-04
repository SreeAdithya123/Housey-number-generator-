-- Housey: let a player draw the next number for the shared game.
--
-- Calling numbers used to be something only the admin's browser could do,
-- because the decoy-then-forced "fixed winner" trick needs tickets and
-- armed rigs (game_admin), which players must never see. This function
-- does that drawing in the database instead: it runs with elevated rights
-- so it can read game_admin internally, but it only ever writes and returns
-- public.game_public, never tickets or rigs, to the caller.
--
-- It mirrors js/game.js Game.callNext()/evaluateWins() exactly (decoy count,
-- then an armed rig's remaining numbers in random order, else a genuine
-- random draw; every prize re-checked against every ticket on every call).
--
-- Run this ONCE in your Supabase project (SQL Editor -> New query -> paste
-- -> Run). It is safe to run again.

create or replace function public.call_next_number()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  pub record;
  adm record;
  pool integer[];
  num integer := null;
  decoy_phase boolean;
  prize_keys text[] := array['earlyFive', 'topLine', 'middleLine', 'bottomLine', 'fullHouse'];
  pkey text;
  rig_ticket_id text;
  ticket jsonb;
  ticket_row jsonb;
  ticket_numbers integer[];
  row_numbers integer[];
  candidates integer[];
  matched integer[];
  have_count integer;
  need_count integer;
  row_idx integer;
  total_numbers integer;
  new_called integer[];
  new_wins jsonb;
begin
  select * into pub from public.game_public where id = 1 for update;
  select * into adm from public.game_admin where id = 1 for update;

  if pub.status is distinct from 'running' then
    return jsonb_build_object('ok', false, 'reason', 'not_running');
  end if;

  if pub.called is null or cardinality(pub.called) >= 90 then
    return jsonb_build_object('ok', false, 'reason', 'finished');
  end if;

  select coalesce(array_agg(n), array[]::integer[]) into pool
  from generate_series(1, 90) n
  where n <> all (pub.called);

  decoy_phase := cardinality(pub.called) < coalesce(adm.decoy_count, 2);

  if not decoy_phase then
    foreach pkey in array prize_keys loop
      if coalesce(pub.wins, '{}'::jsonb) ? pkey then
        continue;
      end if;

      rig_ticket_id := adm.rigs ->> pkey;
      if rig_ticket_id is null then
        continue;
      end if;

      select elem into ticket
      from jsonb_array_elements(coalesce(adm.tickets, '[]'::jsonb)) elem
      where elem ->> 'id' = rig_ticket_id
      limit 1;

      if ticket is null then
        continue;
      end if;

      select coalesce(array_agg(value::integer), array[]::integer[]) into ticket_numbers
      from jsonb_array_elements_text(ticket -> 'numbers') value
      where value is not null;

      if pkey = 'earlyFive' then
        select count(*) into have_count from unnest(ticket_numbers) n where n = any (pub.called);
        need_count := greatest(0, 5 - have_count);
        if need_count = 0 then
          continue;
        end if;
        select coalesce(array_agg(n), array[]::integer[]) into candidates
        from unnest(ticket_numbers) n where not (n = any (pub.called));
      elsif pkey = 'fullHouse' then
        select coalesce(array_agg(n), array[]::integer[]) into candidates
        from unnest(ticket_numbers) n where not (n = any (pub.called));
      else
        row_idx := case pkey when 'topLine' then 0 when 'middleLine' then 1 else 2 end;
        select coalesce(array_agg(value::integer), array[]::integer[]) into row_numbers
        from jsonb_array_elements_text(ticket -> 'grid' -> row_idx) value
        where value is not null;
        select coalesce(array_agg(n), array[]::integer[]) into candidates
        from unnest(row_numbers) n where not (n = any (pub.called));
      end if;

      if candidates is not null and cardinality(candidates) > 0 then
        num := candidates[1 + floor(random() * cardinality(candidates))::integer];
        exit;
      end if;
    end loop;
  end if;

  if num is null then
    if pool is null or cardinality(pool) = 0 then
      return jsonb_build_object('ok', false, 'reason', 'finished');
    end if;
    num := pool[1 + floor(random() * cardinality(pool))::integer];
  end if;

  new_called := pub.called || num;
  new_wins := coalesce(pub.wins, '{}'::jsonb);

  foreach pkey in array prize_keys loop
    if new_wins ? pkey then
      continue;
    end if;

    for ticket_row in select elem from jsonb_array_elements(coalesce(adm.tickets, '[]'::jsonb)) elem loop
      select coalesce(array_agg(value::integer), array[]::integer[]) into ticket_numbers
      from jsonb_array_elements_text(ticket_row -> 'numbers') value
      where value is not null;

      total_numbers := cardinality(ticket_numbers);
      if total_numbers = 0 then
        continue;
      end if;

      select coalesce(array_agg(n), array[]::integer[]) into matched
      from unnest(ticket_numbers) n where n = any (new_called);

      if pkey = 'earlyFive' then
        if cardinality(matched) >= 5 then
          new_wins := new_wins || jsonb_build_object(pkey, jsonb_build_object('name', ticket_row ->> 'name', 'atCall', cardinality(new_called)));
          exit;
        end if;
      elsif pkey = 'fullHouse' then
        if cardinality(matched) = total_numbers then
          new_wins := new_wins || jsonb_build_object(pkey, jsonb_build_object('name', ticket_row ->> 'name', 'atCall', cardinality(new_called)));
          exit;
        end if;
      else
        row_idx := case pkey when 'topLine' then 0 when 'middleLine' then 1 else 2 end;
        select coalesce(array_agg(value::integer), array[]::integer[]) into row_numbers
        from jsonb_array_elements_text(ticket_row -> 'grid' -> row_idx) value
        where value is not null;

        if cardinality(row_numbers) > 0 and row_numbers <@ new_called then
          new_wins := new_wins || jsonb_build_object(pkey, jsonb_build_object('name', ticket_row ->> 'name', 'atCall', cardinality(new_called)));
          exit;
        end if;
      end if;
    end loop;
  end loop;

  update public.game_public
     set called = new_called,
         current_number = num,
         wins = new_wins,
         status = case when cardinality(new_called) >= 90 then 'finished' else pub.status end
   where id = 1;

  return jsonb_build_object('ok', true, 'number', num);
end;
$$;

revoke all on function public.call_next_number() from public;
grant execute on function public.call_next_number() to anon, authenticated;
