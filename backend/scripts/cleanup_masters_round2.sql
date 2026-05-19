-- Round 2 of master cleanup (2026-04-13) — junk warehouses and empty workflows
-- found while debugging the approval bug.

SET FOREIGN_KEY_CHECKS=0;

-- Drop clearly dev junk warehouses. All have zero stock, zero users, zero POs.
-- Keeping only: 1 Penamaluru AP108, 2 Bobbilli, 3 Penamaluru AP104, 4 Central Vijayawada.
DELETE FROM warehouses WHERE id IN (5,6,7,8,9,13,19);  -- UI Test / QA Test / typo
-- Keeping id 18 "CENTRAL" for now — user decides if it's real.

-- Drop empty project-scoped workflows that have ZERO levels defined.
-- Any submission matched to these would either crash or leave the document in
-- a permanently-pending state. They reference project ids 1,3,5 for indent_return,
-- stock_adjustment, grn — all currently unused doc types on prod.
DELETE FROM approval_levels WHERE workflow_id IN (9,10,11,12);
DELETE FROM approval_workflows WHERE id IN (9,10,11,12);

-- Drop the unused "QA Tester Updated" role that has zero permissions and zero users.
DELETE FROM role_permissions WHERE role_id = 17;
DELETE FROM user_roles WHERE role_id = 17;
DELETE FROM roles WHERE id = 17;

SET FOREIGN_KEY_CHECKS=1;

SELECT 'remaining warehouses' type, COUNT(*) n FROM warehouses
UNION ALL SELECT 'remaining workflows', COUNT(*) FROM approval_workflows
UNION ALL SELECT 'remaining roles', COUNT(*) FROM roles;
