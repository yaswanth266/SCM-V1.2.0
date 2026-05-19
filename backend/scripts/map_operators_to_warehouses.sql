-- 2026-05-06 — Operators were only mapped to CENTRAL, so approved indents
-- at AP104 / AP108 had no one able to issue stock. Extend the warehouse
-- managers + store_keeper + warehouse_operator to cover all three live
-- warehouses (CENTRAL=18, AP108=1, AP104=3).

INSERT IGNORE INTO user_warehouses (user_id, warehouse_id)
SELECT u.id, w.id
FROM users u
CROSS JOIN warehouses w
WHERE u.username IN ('rajeswararao', 'sreenivasulu', 'scm.support')
  AND w.id IN (1, 3, 18);

-- Verify
SELECT u.id, u.username, GROUP_CONCAT(DISTINCT r.code) roles,
       GROUP_CONCAT(DISTINCT w.id ORDER BY w.id) wh_ids,
       GROUP_CONCAT(DISTINCT w.name ORDER BY w.id) whs
FROM users u
LEFT JOIN user_roles ur ON ur.user_id=u.id
LEFT JOIN roles r ON r.id=ur.role_id
LEFT JOIN user_warehouses uw ON uw.user_id=u.id
LEFT JOIN warehouses w ON w.id=uw.warehouse_id
WHERE u.username IN ('rajeswararao', 'sreenivasulu', 'scm.support')
GROUP BY u.id, u.username
ORDER BY u.id;
