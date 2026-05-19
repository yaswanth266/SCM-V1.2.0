-- 2026-05-06 — Realign field staff + supervisors so approval routes by project
-- via warehouse separation. PH1 team → AP108, PH2 team → AP104.

SET FOREIGN_KEY_CHECKS = 0;

-- 1. Wipe existing warehouse mappings for field users + mohanbabu so we start fresh
DELETE FROM user_warehouses WHERE user_id IN (1,2,3,4,5,6,7,8,9,10,11,12,13,14);
DELETE FROM user_projects   WHERE user_id IN (1,2,3,4,5,6,7,8,9,10,11,12,13,14);

-- 2. PH1 (108) field staff → warehouse AP108 (id=1) + project PH1 (id=1)
INSERT INTO user_warehouses (user_id, warehouse_id) VALUES
  (1,1),(2,1),(3,1),(4,1),(5,1),(12,1),(13,1);
INSERT INTO user_projects   (user_id, project_id)   VALUES
  (1,1),(2,1),(3,1),(4,1),(5,1),(12,1),(13,1);

-- 3. PH2 (104) field staff → warehouse AP104 (id=3) + project PH2 (id=2)
INSERT INTO user_warehouses (user_id, warehouse_id) VALUES
  (6,3),(7,3),(8,3),(9,3),(10,3),(11,3);
INSERT INTO user_projects   (user_id, project_id)   VALUES
  (6,2),(7,2),(8,2),(9,2),(10,2),(11,2);

-- 4. mohanbabu (id=14, field_supervisor) → AP108 + PH1
INSERT INTO user_warehouses (user_id, warehouse_id) VALUES (14,1);
INSERT INTO user_projects   (user_id, project_id)   VALUES (14,1);

-- 5. Create supervisor104 user (field_supervisor) on AP104 + PH2
--    Password = Audit@123 (same bcrypt hash already used by himaja)
INSERT INTO users (username, email, password_hash, first_name, last_name, user_type, is_active, organization_id, active_role_id, created_at, updated_at)
SELECT 'supervisor104', 'supervisor104@bhspl.local', u.password_hash,
       'Supervisor', '104', 'field_staff', 1, u.organization_id,
       (SELECT id FROM roles WHERE code='field_supervisor' LIMIT 1),
       NOW(), NOW()
FROM users u WHERE u.username='himaja'
  AND NOT EXISTS (SELECT 1 FROM users WHERE username='supervisor104');

SET @new_uid := (SELECT id FROM users WHERE username='supervisor104');

INSERT INTO user_roles (user_id, role_id)
SELECT @new_uid, id FROM roles WHERE code='field_supervisor'
  AND NOT EXISTS (SELECT 1 FROM user_roles WHERE user_id=@new_uid);

INSERT INTO user_warehouses (user_id, warehouse_id) VALUES (@new_uid, 3)
  ON DUPLICATE KEY UPDATE warehouse_id=warehouse_id;
INSERT INTO user_projects   (user_id, project_id)   VALUES (@new_uid, 2)
  ON DUPLICATE KEY UPDATE project_id=project_id;

SET FOREIGN_KEY_CHECKS = 1;

-- Verify
SELECT u.id, u.username, GROUP_CONCAT(DISTINCT r.code) roles,
       GROUP_CONCAT(DISTINCT p.name) projs,
       GROUP_CONCAT(DISTINCT w.name) whs
FROM users u
LEFT JOIN user_roles ur ON ur.user_id=u.id
LEFT JOIN roles r ON r.id=ur.role_id
LEFT JOIN user_projects up ON up.user_id=u.id
LEFT JOIN projects p ON p.id=up.project_id
LEFT JOIN user_warehouses uw ON uw.user_id=u.id
LEFT JOIN warehouses w ON w.id=uw.warehouse_id
WHERE u.id IN (1,2,3,4,5,6,7,8,9,10,11,12,13,14) OR u.username='supervisor104'
GROUP BY u.id, u.username
ORDER BY u.id;
