-- Hostel Allotment Portal: PostgreSQL prototype (PostgreSQL 14+)
-- Run in Supabase SQL editor, or: psql -f hostel_portal_schema.sql
-- Sections: 1 types, 2 people, 3 hostel, 4 applications, 5 rank list, 6 rounds and groups,
--           7 results, 8 notifications and audit, 9 rules (triggers), 10 allocation, 11 sample data, 12 queries

-- 1. TYPES -------------------------------------------------------------
create type user_role     as enum ('student', 'verifier', 'admin');
create type review_status as enum ('pending', 'verified', 'flagged');
create type round_status  as enum ('draft', 'open', 'closed', 'published');
create type member_state  as enum ('invited', 'accepted', 'declined');

-- 2. PEOPLE ------------------------------------------------------------
create table users (
  id            uuid primary key default gen_random_uuid(),
  email         text not null unique,
  password_hash text not null,                       -- bcrypt hash, never the password
  role          user_role not null default 'student',
  created_at    timestamptz not null default now()
);

create table students (
  user_id         uuid primary key references users(id) on delete cascade,
  roll_no         text not null unique,
  full_name       text not null,
  branch          text not null,
  category        text not null,                     -- Open, OBC, SC, ST ...
  cgpa            numeric(4,2) check (cgpa between 0 and 10),
  cet_percentile  numeric(5,2) check (cet_percentile between 0 and 100),
  distance_km     int not null check (distance_km >= 0)   -- home to campus; eligible if > 100
);

-- 3. HOSTEL ------------------------------------------------------------
create table hostels (
  id     int generated always as identity primary key,
  name   text not null unique,
  gender text not null check (gender in ('M', 'F'))
);

create table rooms (
  id            int generated always as identity primary key,
  hostel_id     int not null references hostels(id),
  room_no       text not null,
  floor         int not null,
  capacity      int not null default 4 check (capacity > 0),
  washroom_side text check (washroom_side in ('left', 'right')),
  facing        text,                                -- courtyard, road ...
  plan_x        int,                                 -- position on the floor-plan picture
  plan_y        int,
  is_active     boolean not null default true,       -- false = under repair
  unique (hostel_id, room_no)
);

create table seat_matrix (
  id            int generated always as identity primary key,
  academic_year text not null,
  hostel_id     int not null references hostels(id),
  category      text not null,
  branch        text,                                -- null = all branches
  seats         int not null check (seats >= 0),
  unique (academic_year, hostel_id, category, branch)
);

-- 4. APPLICATIONS AND DOCUMENTS ---------------------------------------
create table applications (
  id                int generated always as identity primary key,
  student_id        uuid not null references students(user_id),
  academic_year     text not null,
  resubmit_deadline timestamptz,
  created_at        timestamptz not null default now(),
  unique (student_id, academic_year)
);

create table documents (
  id             bigint generated always as identity primary key,
  application_id int not null references applications(id) on delete cascade,
  doc_type       text not null,                      -- marksheet_10, distance_certificate ...
  storage_path   text not null,                      -- path in the PRIVATE bucket
  status         review_status not null default 'pending',
  remark         text,
  uploaded_at    timestamptz not null default now(),
  reviewed_by    uuid references users(id),
  reviewed_at    timestamptz,
  constraint flag_needs_remark check (status <> 'flagged' or length(trim(coalesce(remark, ''))) > 0)
);

create table reopen_windows (
  id             int generated always as identity primary key,
  application_id int not null references applications(id),
  new_deadline   timestamptz not null,
  reason         text not null,
  set_by         uuid not null references users(id),
  created_at     timestamptz not null default now()
);

-- An application is verified when it has documents and all are verified
create view v_application_status as
select a.id as application_id, a.student_id, a.academic_year,
  case
    when count(d.id) = 0                              then 'pending'
    when bool_or(d.status = 'flagged')                then 'flagged'
    when bool_and(d.status = 'verified')              then 'verified'
    else 'pending'
  end as status
from applications a left join documents d on d.application_id = a.id
group by a.id;

-- 5. RANK LIST (versioned, frozen) ------------------------------------
create table rank_list_versions (
  id            int generated always as identity primary key,
  academic_year text not null,
  version       int not null,
  basis         text not null check (basis in ('cgpa', 'cet_percentile', 'state_merit')),
  created_by    uuid references users(id),
  created_at    timestamptz not null default now(),
  frozen_at     timestamptz,                         -- set when the objection window closes
  content_hash  text,                                -- published hash of the frozen list
  unique (academic_year, version)
);

create table rank_list_entries (
  version_id int not null references rank_list_versions(id),
  rank       int not null,
  student_id uuid not null references students(user_id),
  score      numeric(6,2),
  primary key (version_id, rank),
  unique (version_id, student_id)
);

create table objections (
  id          int generated always as identity primary key,
  version_id  int not null references rank_list_versions(id),
  student_id  uuid not null references students(user_id),
  message     text not null,
  resolved_by uuid references users(id),
  resolution  text,
  created_at  timestamptz not null default now()
);

-- 6. ROUNDS, ELIGIBILITY, GROUPS, PREFERENCES -------------------------
create table allotment_rounds (
  id              int generated always as identity primary key,
  academic_year   text not null,
  round_no        int not null,
  rank_version_id int not null references rank_list_versions(id),
  status          round_status not null default 'draft',
  opened_at       timestamptz,
  closed_at       timestamptz,
  published_at    timestamptz,
  unique (academic_year, round_no)
);

create table eligibility (                           -- filled from the admin's CSV of roll numbers
  round_id   int  not null references allotment_rounds(id),
  student_id uuid not null references students(user_id),
  primary key (round_id, student_id)
);

create table groups (
  id         bigint generated always as identity primary key,
  round_id   int  not null references allotment_rounds(id),
  leader_id  uuid not null references students(user_id),
  locked_at  timestamptz,                            -- preferences submitted
  created_at timestamptz not null default now(),
  unique (id, round_id),
  unique (round_id, leader_id)
);

create table group_members (
  group_id   bigint not null,
  round_id   int    not null,
  student_id uuid   not null references students(user_id),
  state      member_state not null default 'invited',
  invited_at timestamptz not null default now(),
  primary key (group_id, student_id),
  foreign key (group_id, round_id) references groups(id, round_id) on delete cascade
);
-- one accepted group per student per round
create unique index one_group_per_round on group_members (round_id, student_id) where state = 'accepted';

create table group_preferences (
  group_id  bigint not null references groups(id) on delete cascade,
  choice_no int    not null check (choice_no between 1 and 5),
  room_id   int    not null references rooms(id),
  primary key (group_id, choice_no),
  unique (group_id, room_id)
);

-- 7. RESULTS -----------------------------------------------------------
create table allotments (
  id            bigint generated always as identity primary key,
  academic_year text   not null,
  round_id      int    not null references allotment_rounds(id),
  group_id      bigint not null references groups(id),
  room_id       int    not null references rooms(id),
  choice_no     int    not null,                     -- which preference was granted
  rank_used     int    not null,                     -- the rank that decided it
  created_at    timestamptz not null default now(),
  unique (academic_year, room_id),                   -- a room can never go to two groups
  unique (round_id, group_id)
);

-- 8. NOTIFICATIONS AND AUDIT -------------------------------------------
create table notifications (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references users(id),
  title      text not null,
  body       text,
  read_at    timestamptz,
  created_at timestamptz not null default now()
);

create table audit_log (                             -- add-only: nobody can edit or delete
  id         bigint generated always as identity primary key,
  actor_id   uuid,
  action     text not null,
  entity     text not null,
  entity_id  text,
  details    jsonb,
  created_at timestamptz not null default now()
);

create index on documents (application_id);
create index on group_members (student_id);
create index on allotments (round_id);
create index on notifications (user_id, read_at);

-- 9. RULES THE DATABASE ENFORCES ---------------------------------------
-- 9a. A group never has more than 4 people (invited + accepted)
create function trg_group_max_four() returns trigger language plpgsql as $$
begin
  if (select count(*) from group_members
      where group_id = new.group_id and state in ('invited', 'accepted')
        and student_id <> new.student_id) >= 4 then
    raise exception 'A group can have at most 4 members';
  end if;
  return new;
end $$;
create trigger group_max_four before insert on group_members
  for each row when (new.state in ('invited', 'accepted')) execute function trg_group_max_four();

-- 9b. Rank list entries cannot change; new ones only while the list is not frozen
create function trg_rank_entries_locked() returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    if (select frozen_at from rank_list_versions where id = new.version_id) is not null then
      raise exception 'Rank list is frozen';
    end if;
    return new;
  end if;
  raise exception 'Rank list entries cannot be edited or deleted';
end $$;
create trigger rank_entries_locked before insert or update or delete on rank_list_entries
  for each row execute function trg_rank_entries_locked();

-- 9c. A frozen version cannot be changed or deleted
create function trg_version_frozen() returns trigger language plpgsql as $$
begin
  if old.frozen_at is not null then
    raise exception 'Frozen rank list version cannot be changed';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;
create trigger version_frozen before update or delete on rank_list_versions
  for each row execute function trg_version_frozen();

-- 9d. Audit log is add-only
create function trg_audit_append_only() returns trigger language plpgsql as $$
begin
  raise exception 'audit_log is add-only';
end $$;
create trigger audit_append_only before update or delete on audit_log
  for each row execute function trg_audit_append_only();

-- 10. ALLOCATION --------------------------------------------------------
-- Groups ready for allotment: exactly 4 accepted members, all on the rank list, at least 1 preference.
-- Group rank = best (lowest) rank among its members. Use avg(e.rank) if your college averages instead.
create view v_ready_groups as
select g.id as group_id, g.round_id, min(e.rank) as group_rank
from groups g
join allotment_rounds r on r.id = g.round_id
join group_members m on m.group_id = g.id and m.state = 'accepted'
join rank_list_entries e on e.version_id = r.rank_version_id and e.student_id = m.student_id
where exists (select 1 from group_preferences p where p.group_id = g.id)
group by g.id, g.round_id
having count(*) = 4;

-- Same input always gives the same output (ties broken by group id). Safe to re-run until published.
create function allocate_round(p_round int) returns int language plpgsql as $$
declare
  yr text; g record; p record; n int := 0;
begin
  select academic_year into yr from allotment_rounds where id = p_round;
  if exists (select 1 from allotment_rounds where id = p_round and status = 'published') then
    raise exception 'Round already published';
  end if;
  delete from allotments where round_id = p_round;

  for g in select group_id, group_rank from v_ready_groups
           where round_id = p_round order by group_rank, group_id loop
    for p in select gp.room_id, gp.choice_no
             from group_preferences gp join rooms rm on rm.id = gp.room_id
             where gp.group_id = g.group_id and rm.is_active and rm.capacity = 4
             order by gp.choice_no loop
      if not exists (select 1 from allotments a where a.academic_year = yr and a.room_id = p.room_id) then
        insert into allotments (academic_year, round_id, group_id, room_id, choice_no, rank_used)
        values (yr, p_round, g.group_id, p.room_id, p.choice_no, g.group_rank);
        n := n + 1;
        exit;                                      -- this group is done, next group
      end if;
    end loop;
  end loop;

  insert into audit_log (action, entity, entity_id, details)
  values ('allocate', 'round', p_round::text, jsonb_build_object('groups_allotted', n));
  return n;
end $$;

-- 11. SAMPLE DATA --------------------------------------------------------
insert into hostels (name, gender) values ('Boys Hostel A', 'M');

insert into rooms (hostel_id, room_no, floor, washroom_side, facing, plan_x, plan_y)
select 1, (200 + g)::text, 2,
       case when g % 2 = 0 then 'left' else 'right' end,
       case when g <= 6 then 'courtyard' else 'road' end,
       (g - 1) % 6, (g - 1) / 6
from generate_series(1, 12) g;

insert into users (id, email, password_hash, role)
select ('00000000-0000-0000-0000-00000000000' || g)::uuid, 'student' || g || '@college.edu',
       '$2b$10$replace_with_real_bcrypt_hash', 'student'
from generate_series(1, 6) g;
insert into users (id, email, password_hash, role)
values ('00000000-0000-0000-0000-000000000009', 'admin@college.edu', '$2b$10$replace_with_real_bcrypt_hash', 'admin');

insert into students (user_id, roll_no, full_name, branch, category, cgpa, distance_km) values
 ('00000000-0000-0000-0000-000000000001', '24CS101', 'Aarav Patil', 'CSE', 'Open', 8.90, 340),
 ('00000000-0000-0000-0000-000000000002', '24CS007', 'Riya Shah',   'CSE', 'Open', 9.20, 410),
 ('00000000-0000-0000-0000-000000000003', '24EE044', 'Kabir Rao',   'EE',  'OBC',  8.70, 220),
 ('00000000-0000-0000-0000-000000000004', '24ME019', 'Neha Joshi',  'ME',  'Open', 8.40, 150),
 ('00000000-0000-0000-0000-000000000005', '24EC033', 'Sana Khan',   'ECE', 'Open', 8.60, 190),
 ('00000000-0000-0000-0000-000000000006', '24CE070', 'Dev Mehta',   'CE',  'SC',   7.90, 260);

-- Rank list v1: CGPA high to low, ties by roll number; then freeze and publish the hash
insert into rank_list_versions (academic_year, version, basis, created_by)
values ('2026-27', 1, 'cgpa', '00000000-0000-0000-0000-000000000009');

insert into rank_list_entries (version_id, rank, student_id, score)
select 1, row_number() over (order by cgpa desc, roll_no), user_id, cgpa from students;

update rank_list_versions
set frozen_at = now(),
    content_hash = (select md5(string_agg(student_id::text, ',' order by rank))
                    from rank_list_entries where version_id = 1)
where id = 1;

insert into allotment_rounds (academic_year, round_no, rank_version_id, status)
values ('2026-27', 1, 1, 'open');

-- One group of 4 (students 1-4) with 3 room preferences
insert into groups (round_id, leader_id, locked_at)
values (1, '00000000-0000-0000-0000-000000000001', now());

insert into group_members (group_id, round_id, student_id, state)
select 1, 1, user_id, 'accepted' from students
where user_id in ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002',
                  '00000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000004');

insert into group_preferences (group_id, choice_no, room_id) values (1, 1, 4), (1, 2, 5), (1, 3, 6);

select allocate_round(1) as groups_allotted;

-- 12. USEFUL QUERIES -------------------------------------------------------
-- Public allotment list (what every student can see)
create view v_public_allotments as
select a.academic_year, r.round_no, a.rank_used, l.full_name as group_leader,
       rm.room_no, a.choice_no as preference_granted
from allotments a
join allotment_rounds r on r.id = a.round_id
join groups g on g.id = a.group_id
join students l on l.user_id = g.leader_id
join rooms rm on rm.id = a.room_id
order by a.rank_used;

-- Vacant rooms for a year
create view v_vacant_rooms as
select rm.*, '2026-27' as academic_year
from rooms rm
where rm.is_active
  and not exists (select 1 from allotments a where a.room_id = rm.id and a.academic_year = '2026-27');

-- select * from v_public_allotments;
-- select * from v_vacant_rooms;
-- select * from v_application_status;