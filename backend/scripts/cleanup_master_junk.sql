-- Remove dev/test junk from masters (2026-04-13)
-- Items: Playwright test fixtures, XSS payload, "sritest", "No Code Test"
-- Vendors: all UI/QA/Playwright test vendors, dup rows

SET FOREIGN_KEY_CHECKS=0;

-- Clean dependent rows in all master-side tables first
DELETE FROM vendor_items    WHERE item_id   IN (801,802,803,804,805,806,808,10472,10476);
DELETE FROM vendor_items    WHERE vendor_id IN (5,6,7,10,11,12,13,14,247,248,250,251,252,256,257,258);
DELETE FROM price_list_items WHERE item_id  IN (801,802,803,804,805,806,808,10472,10476);
DELETE FROM item_kit_components WHERE item_id IN (801,802,803,804,805,806,808,10472,10476);
DELETE FROM rate_contract_items WHERE item_id IN (801,802,803,804,805,806,808,10472,10476);
DELETE FROM rate_contracts  WHERE vendor_id IN (5,6,7,10,11,12,13,14,247,248,250,251,252,256,257,258);
DELETE FROM vendor_contracts WHERE vendor_id IN (5,6,7,10,11,12,13,14,247,248,250,251,252,256,257,258);
DELETE FROM vendor_ratings  WHERE vendor_id IN (5,6,7,10,11,12,13,14,247,248,250,251,252,256,257,258);
DELETE FROM vendor_scorecards WHERE vendor_id IN (5,6,7,10,11,12,13,14,247,248,250,251,252,256,257,258);

-- Items: explicit test fixtures only. PRESERVE 340 (Test Tubes), 447 (Glucose Strips),
-- 859/860 (Lab Test Record), 1254 (Duphalac) — those are legit despite name substring.
DELETE FROM items WHERE id IN (
    801, -- PW-TEST-1775593686633 Playwright Updated Item
    802, -- FLOW5 Workflow Test Medicine
    803, -- FLOW5 Workflow Test Medicine
    804, -- PW-TEST Playwright Updated Item
    805, -- FLOW5 Workflow Test Medicine
    806, -- FUNC Functional Test Item
    808, -- sritest
    10472, -- No Code Test (empty item_code)
    10476  -- XSS payload
);

DELETE FROM vendors WHERE id IN (
    5,6,7,          -- UI Test Pharma Supplier
    10,             -- QA Test Vendor
    11,12,13,14,    -- UI Test Vendor Playwright
    247,            -- Dup Vendor
    248,            -- Bad Email
    250,            -- Test Validation Vendor
    251,            -- Email Test Vendor
    252,            -- Test
    256,            -- RETIRED Dup 1
    257,            -- QATV4 GST Good
    258             -- QATV_DUP Dup 1
);

SET FOREIGN_KEY_CHECKS=1;

SELECT (SELECT COUNT(*) FROM items) AS items_remaining, (SELECT COUNT(*) FROM vendors) AS vendors_remaining;
