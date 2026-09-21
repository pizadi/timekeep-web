-- 0008: social layer, phase 4 — group projects (members-only, feature 6).
--  - projects.group_id: NULL = personal project (user_id is the owner);
--    set = the project belongs to a group and every CURRENT member can see it
--    (access enforced in src/worker/access.ts). Row user_id stays the CREATOR
--    for audit; tasks/sessions keep their per-user attribution, so the
--    single-timer invariant and personal reports are untouched.
--  - Deleting the group cascades the projects (and their tasks/sessions).
--  - Additive ADD COLUMN only (D1 rebuild gotcha, see 0003).
ALTER TABLE projects ADD COLUMN group_id TEXT REFERENCES groups(id) ON DELETE CASCADE;
CREATE INDEX idx_projects_group ON projects(group_id);
