-- Fix approval workflow misconfiguration (2026-04-13).
-- Before: every workflow's every level had approver_role_id = 1 (Super Admin),
-- so no other role could see pending approvals. Murali submitted an indent;
-- it never appeared for Mahesh or the Purchase Manager.
--
-- After: sensible per-document approver matrix.
--   role_id reference: 1=Super Admin, 2=Admin, 3=Warehouse Manager,
--   5=Purchase Manager, 7=Accounts Manager, 9=Logistics Manager

-- Drop orphan duplicate workflows (1-4) — their document_type strings don't
-- match what the code sends (e.g. "Purchase Order" vs "purchase_order").
-- Active code only uses workflows 5-8 plus project-scoped 9-12.
DELETE FROM approval_levels WHERE workflow_id IN (1,2,3,4);
DELETE FROM approval_workflows WHERE id IN (1,2,3,4);

-- Workflow 5: Indent Approval (document_type='indent')
--   L1 = Warehouse Manager acknowledges feasibility
--   L2 = Purchase Manager signs off on procurement need
UPDATE approval_levels SET approver_role_id = 3 WHERE workflow_id = 5 AND level = 1;
UPDATE approval_levels SET approver_role_id = 5 WHERE workflow_id = 5 AND level = 2;

-- Workflow 6: Material Request Approval (document_type='material_request')
--   Same path as indent
UPDATE approval_levels SET approver_role_id = 3 WHERE workflow_id = 6 AND level = 1;
UPDATE approval_levels SET approver_role_id = 5 WHERE workflow_id = 6 AND level = 2;

-- Workflow 7: Purchase Order Approval (document_type='purchase_order')
--   L1 = Purchase Manager (operational sign-off)
--   L2 = Admin / Super Admin (financial sign-off)
UPDATE approval_levels SET approver_role_id = 5 WHERE workflow_id = 7 AND level = 1;
UPDATE approval_levels SET approver_role_id = 1 WHERE workflow_id = 7 AND level = 2;

-- Workflow 8: Stock Transfer Approval (document_type='stock_transfer')
--   Single level, warehouse manager signs off
UPDATE approval_levels SET approver_role_id = 3 WHERE workflow_id = 8;

SELECT w.id AS wf, w.name, w.document_type, al.level, al.approver_role_id, r.name AS role
FROM approval_workflows w
LEFT JOIN approval_levels al ON al.workflow_id = w.id
LEFT JOIN roles r ON r.id = al.approver_role_id
WHERE w.id IN (5,6,7,8)
ORDER BY w.id, al.level;
