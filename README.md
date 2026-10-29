# Hostel Portal Backend (Node.js + Express + PostgreSQL)

REST API for the first-year hostel admission and room allotment portal.
It works with `hostel_portal_schema.sql` (the database file). Run that file first.

## Setup
1. Install Node.js 18 or newer.
2. Run the schema: paste `hostel_portal_schema.sql` into the Supabase SQL editor (or `psql -f hostel_portal_schema.sql`).
3. In Supabase Storage, create a PRIVATE bucket called `documents`.
4. `cp .env.example .env` and fill in the values.
5. `npm install`
6. Set real passwords for the sample users (the schema has placeholder hashes):
   `node scripts/hash.js MyPassword123` then in SQL:
   `update users set password_hash = '<hash>' where email = 'admin@college.edu';`
7. `npm run dev` (API on http://localhost:4000, check http://localhost:4000/health)

## Endpoints
Send the token as `Authorization: Bearer <token>`.

| Area | Method + path | Who | Notes |
|---|---|---|---|
| Auth | POST /auth/login | anyone | body: email, password |
| Auth | GET /me | logged in | my profile |
| Documents | POST /documents | student | multipart: doc_type, file (PDF/JPG/PNG, 5 MB) |
| Documents | GET /documents | student | my documents and status |
| Documents | GET /documents/:id/link | owner, verifier, admin | link lasts 60 s, every open is logged |
| Verify | POST /admin/documents/:id/approve | verifier, admin | |
| Verify | POST /admin/documents/:id/flag | verifier, admin | body: remark (required) |
| Rank list | POST /admin/ranklist | admin | body: basis = cgpa or cet_percentile |
| Rank list | POST /admin/ranklist/:version/freeze | admin | locks list, stores sha256 hash |
| Rank list | GET /ranklist/:version | logged in | |
| Rounds | POST /admin/rounds | admin | body: round_no, rank_version (must be frozen) |
| Rounds | POST /admin/rounds/:id/status | admin | body: status = open or closed |
| Rounds | POST /admin/rounds/:id/eligibility | admin | CSV of roll numbers, field "file" |
| Groups | POST /groups | student | body: round_id |
| Groups | POST /groups/:id/invite | leader | body: roll_no |
| Groups | POST /groups/:id/accept, /decline | invited student | |
| Groups | GET /groups/mine?round_id= | student | members and preferences |
| Preferences | PUT /groups/:id/preferences | leader | body: room_ids (1 to 5), submit |
| Rounds | POST /admin/rounds/:id/run | admin | round must be closed |
| Rounds | POST /admin/rounds/:id/publish | admin | notifies students |
| Public | GET /allotments?round= | logged in | published results only |
| Public | GET /rooms/vacant | logged in | |

## Order of events (matches your flow)
verify documents -> generate rank list -> freeze -> create round -> upload eligibility CSV -> open round
-> students form groups and submit preferences -> close round -> run allocation -> publish.

## Quick test with curl
```
curl -X POST localhost:4000/auth/login -H "Content-Type: application/json" \
  -d '{"email":"admin@college.edu","password":"MyPassword123"}'
curl -X POST localhost:4000/admin/ranklist -H "Authorization: Bearer TOKEN" \
  -H "Content-Type: application/json" -d '{"basis":"cgpa"}'
```

## Notes
- The schema's sample data already contains a frozen rank list, round 1 (open) and a full group, so you can test groups and allocation straight away. Delete it for real use.
- The rules (4 per group, one room per group, frozen rank list, add-only audit log) are enforced by the database, so they hold even if this code has a bug.
- Not included yet: email sending (notifications are saved in the `notifications` table), real virus scanning (`scanForVirus` in `src/storage.js` is a placeholder), the "reopen window" endpoint, and category/branch quota checks.
- Deploy: backend on Render (start command `npm start`, add the .env values as environment variables).
