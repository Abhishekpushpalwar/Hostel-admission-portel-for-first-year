import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { query, tx } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { HttpError, wrap, idParam, audit, notify } from '../utils.js';

const router = Router();
router.use('/groups', requireAuth, requireRole('student'));

// Load a group and its round, locked for this transaction so two requests cannot clash.
async function loadGroup(db, groupId) {
  const g = (await db.query(
    `select g.id, g.round_id, g.leader_id, g.locked_at, r.status as round_status
       from groups g join allotment_rounds r on r.id = g.round_id
      where g.id = $1 and r.academic_year = $2 for update of g`,
    [groupId, config.academicYear]
  )).rows[0];
  if (!g) throw new HttpError(404, 'Group not found');
  return g;
}
const mustBeOpen = (g) => {
  if (g.round_status !== 'open') throw new HttpError(400, 'This round is not open');
};

// POST /groups   body: { round_id }   creates a group with me as leader
router.post('/groups', wrap(async (req, res) => {
  const { round_id } = z.object({ round_id: z.number().int().positive() }).parse(req.body);
  const me = req.user.id;

  const id = await tx(async (db) => {
    const round = (await db.query(
      'select status from allotment_rounds where id = $1 and academic_year = $2', [round_id, config.academicYear]
    )).rows[0];
    if (!round) throw new HttpError(404, 'Round not found');
    if (round.status !== 'open') throw new HttpError(400, 'This round is not open');

    const eligible = await db.query('select 1 from eligibility where round_id = $1 and student_id = $2', [round_id, me]);
    if (!eligible.rowCount) throw new HttpError(403, 'You are not eligible for this round');

    const already = await db.query(
      `select 1 from group_members where round_id = $1 and student_id = $2 and state = 'accepted'`, [round_id, me]);
    if (already.rowCount) throw new HttpError(409, 'You are already in a group for this round');

    const gid = (await db.query(
      'insert into groups (round_id, leader_id) values ($1, $2) returning id', [round_id, me]
    )).rows[0].id;
    await db.query(
      `insert into group_members (group_id, round_id, student_id, state) values ($1, $2, $3, 'accepted')`,
      [gid, round_id, me]
    );
    await audit(db, me, 'create_group', 'group', gid, { round_id });
    return gid;
  });
  res.status(201).json({ id });
}));

// POST /groups/:id/invite   body: { roll_no }   leader only
router.post('/groups/:id/invite', wrap(async (req, res) => {
  const groupId = idParam.parse(req.params.id);
  const { roll_no } = z.object({ roll_no: z.string().trim().min(1).max(30) }).parse(req.body);

  await tx(async (db) => {
    const g = await loadGroup(db, groupId);
    if (g.leader_id !== req.user.id) throw new HttpError(403, 'Only the group leader can invite');
    mustBeOpen(g);
    if (g.locked_at) throw new HttpError(400, 'The group is locked');

    const invitee = (await db.query(
      `select s.user_id, s.full_name from students s
         join eligibility e on e.student_id = s.user_id and e.round_id = $2
        where upper(s.roll_no) = upper($1)`,
      [roll_no, g.round_id]
    )).rows[0];
    if (!invitee) throw new HttpError(404, 'No eligible student with that roll number');

    const taken = await db.query(
      `select 1 from group_members where round_id = $1 and student_id = $2 and state = 'accepted'`,
      [g.round_id, invitee.user_id]
    );
    if (taken.rowCount) throw new HttpError(409, `${invitee.full_name} is already in a group`);

    // The database refuses a 5th member (trigger). A declined invite can be re-sent.
    const ins = await db.query(
      `insert into group_members (group_id, round_id, student_id, state) values ($1, $2, $3, 'invited')
       on conflict (group_id, student_id) do update set state = 'invited', invited_at = now()
         where group_members.state = 'declined'
       returning student_id`,
      [groupId, g.round_id, invitee.user_id]
    );
    if (!ins.rowCount) throw new HttpError(409, `${invitee.full_name} is already invited`);

    await notify(db, invitee.user_id, 'Group invite', 'You have been invited to join a hostel group. Open the portal to accept or decline.');
    await audit(db, req.user.id, 'invite_member', 'group', groupId, { invited: invitee.user_id });
  });
  res.status(201).json({ invited: true });
}));

// POST /groups/:id/accept   I accept my invite
router.post('/groups/:id/accept', wrap(async (req, res) => {
  const groupId = idParam.parse(req.params.id);
  await tx(async (db) => {
    const g = await loadGroup(db, groupId);
    mustBeOpen(g);
    // If I already accepted another group in this round, the unique index rejects this (409).
    const r = await db.query(
      `update group_members set state = 'accepted' where group_id = $1 and student_id = $2 and state = 'invited'`,
      [groupId, req.user.id]
    );
    if (!r.rowCount) throw new HttpError(404, 'You have no pending invite to this group');
    await notify(db, g.leader_id, 'Invite accepted', 'A student accepted your group invite.');
    await audit(db, req.user.id, 'accept_invite', 'group', groupId);
  });
  res.json({ accepted: true });
}));

// POST /groups/:id/decline   I decline my invite
router.post('/groups/:id/decline', wrap(async (req, res) => {
  const groupId = idParam.parse(req.params.id);
  const r = await query(
    `update group_members set state = 'declined' where group_id = $1 and student_id = $2 and state = 'invited'`,
    [groupId, req.user.id]
  );
  if (!r.rowCount) throw new HttpError(404, 'You have no pending invite to this group');
  await audit({ query }, req.user.id, 'decline_invite', 'group', groupId);
  res.json({ declined: true });
}));

// GET /groups/mine?round_id=1   my group in a round: members and room preferences
router.get('/groups/mine', wrap(async (req, res) => {
  const roundId = idParam.parse(req.query.round_id);
  const { rows } = await query(
    `select g.id, g.leader_id = $1 as is_leader, g.locked_at,
       (select coalesce(json_agg(json_build_object('roll_no', s.roll_no, 'name', s.full_name, 'state', m.state) order by m.invited_at), '[]')
          from group_members m join students s on s.user_id = m.student_id where m.group_id = g.id) as members,
       (select coalesce(json_agg(json_build_object('choice_no', p.choice_no, 'room_id', p.room_id, 'room_no', rm.room_no) order by p.choice_no), '[]')
          from group_preferences p join rooms rm on rm.id = p.room_id where p.group_id = g.id) as preferences
     from groups g
    where g.round_id = $2
      and exists (select 1 from group_members m where m.group_id = g.id and m.student_id = $1 and m.state in ('invited', 'accepted'))`,
    [req.user.id, roundId]
  );
  res.json(rows);
}));

// PUT /groups/:id/preferences   body: { room_ids: [..1 to 5 rooms in order of choice], submit?: boolean }
// submit = true locks the preferences (needs 4 accepted members).
router.put('/groups/:id/preferences', wrap(async (req, res) => {
  const groupId = idParam.parse(req.params.id);
  const { room_ids, submit } = z.object({
    room_ids: z.array(z.number().int().positive()).min(1).max(5),
    submit: z.boolean().default(false),
  }).parse(req.body);
  if (new Set(room_ids).size !== room_ids.length) throw new HttpError(400, 'Each room can be chosen only once');

  await tx(async (db) => {
    const g = await loadGroup(db, groupId);
    if (g.leader_id !== req.user.id) throw new HttpError(403, 'Only the group leader can set preferences');
    mustBeOpen(g);
    if (g.locked_at) throw new HttpError(400, 'Preferences were already submitted');

    if (submit) {
      const accepted = (await db.query(
        `select count(*)::int as n from group_members where group_id = $1 and state = 'accepted'`, [groupId]
      )).rows[0].n;
      if (accepted !== 4) throw new HttpError(400, `The group needs exactly 4 accepted members (it has ${accepted})`);
    }

    const rooms = await db.query('select id from rooms where id = any($1::int[]) and is_active', [room_ids]);
    if (rooms.rowCount !== room_ids.length) throw new HttpError(400, 'Some rooms do not exist or are not available');

    const taken = await db.query(
      `select rm.room_no from allotments a join rooms rm on rm.id = a.room_id
        where a.academic_year = $1 and a.room_id = any($2::int[])`,
      [config.academicYear, room_ids]
    );
    if (taken.rowCount) throw new HttpError(400, `Room ${taken.rows[0].room_no} is already allotted`);

    await db.query('delete from group_preferences where group_id = $1', [groupId]);
    await db.query(
      `insert into group_preferences (group_id, choice_no, room_id)
       select $1::bigint, t.ord::int, t.room_id from unnest($2::int[]) with ordinality as t(room_id, ord)`,
      [groupId, room_ids]
    );
    if (submit) await db.query('update groups set locked_at = now() where id = $1', [groupId]);
    await audit(db, req.user.id, submit ? 'submit_preferences' : 'save_preferences', 'group', groupId, { room_ids });
  });
  res.json({ room_ids, locked: submit });
}));

export default router;
