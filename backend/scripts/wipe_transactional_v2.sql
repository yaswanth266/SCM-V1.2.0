-- 2026-05-06 — Second clean wipe before parallel 104 / 108 flow test.
-- Same transactional purge as 2026-05-05. Masters, users, mappings stay.

SET FOREIGN_KEY_CHECKS = 0;

TRUNCATE TABLE consumption_items;
TRUNCATE TABLE consumption_entries;
TRUNCATE TABLE consumption_return_items;
TRUNCATE TABLE consumption_returns;
TRUNCATE TABLE material_issue_items;
TRUNCATE TABLE material_issues;
TRUNCATE TABLE issue_return_items;
TRUNCATE TABLE issue_returns;
TRUNCATE TABLE quality_inspection_items;
TRUNCATE TABLE quality_inspections;
TRUNCATE TABLE putaway_items;
TRUNCATE TABLE putaway_orders;
TRUNCATE TABLE grn_items;
TRUNCATE TABLE goods_receipt_notes;
TRUNCATE TABLE gate_passes;
TRUNCATE TABLE purchase_order_items;
TRUNCATE TABLE purchase_orders;
TRUNCATE TABLE purchase_return_items;
TRUNCATE TABLE purchase_returns;
TRUNCATE TABLE quotation_items;
TRUNCATE TABLE quotations;
TRUNCATE TABLE material_request_items;
TRUNCATE TABLE material_requests;
TRUNCATE TABLE mr_indent_links;
TRUNCATE TABLE mr_buckets;
TRUNCATE TABLE mrp_run_items;
TRUNCATE TABLE mrp_runs;
TRUNCATE TABLE demand_forecasts;
TRUNCATE TABLE indent_acknowledgement_items;
TRUNCATE TABLE indent_acknowledgements;
TRUNCATE TABLE indent_items;
TRUNCATE TABLE indents;
TRUNCATE TABLE approval_history;
TRUNCATE TABLE approval_requests;
TRUNCATE TABLE stock_audit_items;
TRUNCATE TABLE stock_audits;
TRUNCATE TABLE stock_transfer_items;
TRUNCATE TABLE stock_transfers;
TRUNCATE TABLE stock_ledger;
TRUNCATE TABLE stock_balance;
TRUNCATE TABLE batches;
TRUNCATE TABLE batch_recall_traces;
TRUNCATE TABLE batch_recalls;
TRUNCATE TABLE serial_numbers;
TRUNCATE TABLE barcode_registry;
TRUNCATE TABLE invoice_items;
TRUNCATE TABLE invoices;
TRUNCATE TABLE credit_notes;
TRUNCATE TABLE payments;
TRUNCATE TABLE journal_entry_lines;
TRUNCATE TABLE journal_entries;
TRUNCATE TABLE account_ledger;
TRUNCATE TABLE landed_cost_allocations;
TRUNCATE TABLE landed_costs;
TRUNCATE TABLE picking_items;
TRUNCATE TABLE picking_orders;
TRUNCATE TABLE packing_items;
TRUNCATE TABLE packing_orders;
TRUNCATE TABLE wave_plan_orders;
TRUNCATE TABLE wave_plans;
TRUNCATE TABLE delivery_orders;
TRUNCATE TABLE dispatch_orders;
TRUNCATE TABLE mda_items;
TRUNCATE TABLE material_dispatch_advice;
TRUNCATE TABLE sales_order_items;
TRUNCATE TABLE sales_orders;
TRUNCATE TABLE transport_documents;
TRUNCATE TABLE transport_orders;
TRUNCATE TABLE transport_quotations;
TRUNCATE TABLE transport_requirements;
TRUNCATE TABLE shipment_tracking;
TRUNCATE TABLE carrier_tracking;
TRUNCATE TABLE receipt_confirmations;
TRUNCATE TABLE asset_movements;
TRUNCATE TABLE prescription_records;
TRUNCATE TABLE cold_chain_logs;
TRUNCATE TABLE compliance_audits;
TRUNCATE TABLE e_signatures;
TRUNCATE TABLE email_logs;
TRUNCATE TABLE file_attachments;
TRUNCATE TABLE notifications;
TRUNCATE TABLE scan_logs;
TRUNCATE TABLE business_rule_executions;

SET FOREIGN_KEY_CHECKS = 1;

SELECT 'INDENTS' m, COUNT(*) n FROM indents
UNION ALL SELECT 'MRS', COUNT(*) FROM material_requests
UNION ALL SELECT 'GRNS', COUNT(*) FROM goods_receipt_notes
UNION ALL SELECT 'STOCK_BAL', COUNT(*) FROM stock_balance
UNION ALL SELECT 'NOTIFS', COUNT(*) FROM notifications;
