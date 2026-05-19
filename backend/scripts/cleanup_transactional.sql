SET FOREIGN_KEY_CHECKS=0;

TRUNCATE TABLE purchase_order_items;
TRUNCATE TABLE purchase_orders;
TRUNCATE TABLE purchase_return_items;
TRUNCATE TABLE purchase_returns;

TRUNCATE TABLE indent_items;
TRUNCATE TABLE indent_acknowledgement_items;
TRUNCATE TABLE indent_acknowledgements;
TRUNCATE TABLE indents;

TRUNCATE TABLE grn_items;
TRUNCATE TABLE goods_receipt_notes;

TRUNCATE TABLE invoice_items;
TRUNCATE TABLE invoices;
TRUNCATE TABLE payments;
TRUNCATE TABLE credit_notes;

TRUNCATE TABLE quotation_items;
TRUNCATE TABLE quotations;

TRUNCATE TABLE material_request_items;
TRUNCATE TABLE material_requests;
TRUNCATE TABLE material_issue_items;
TRUNCATE TABLE material_issues;

TRUNCATE TABLE stock_transfer_items;
TRUNCATE TABLE stock_transfers;

TRUNCATE TABLE sales_order_items;
TRUNCATE TABLE sales_orders;
TRUNCATE TABLE delivery_orders;
TRUNCATE TABLE dispatch_orders;

TRUNCATE TABLE mda_items;
TRUNCATE TABLE material_dispatch_advice;

TRUNCATE TABLE packing_items;
TRUNCATE TABLE item_packing;
TRUNCATE TABLE packing_orders;

TRUNCATE TABLE picking_items;
TRUNCATE TABLE picking_orders;

TRUNCATE TABLE putaway_items;
TRUNCATE TABLE putaway_orders;

TRUNCATE TABLE wave_plan_orders;
TRUNCATE TABLE wave_plans;

TRUNCATE TABLE transport_documents;
TRUNCATE TABLE transport_orders;
TRUNCATE TABLE transport_quotations;
TRUNCATE TABLE transport_requirements;
TRUNCATE TABLE carrier_tracking;
TRUNCATE TABLE shipment_tracking;

TRUNCATE TABLE receipt_confirmations;

TRUNCATE TABLE quality_inspection_items;
TRUNCATE TABLE quality_inspections;

TRUNCATE TABLE stock_balance;
TRUNCATE TABLE stock_ledger;
TRUNCATE TABLE batch_recall_traces;
TRUNCATE TABLE batch_recalls;
TRUNCATE TABLE batches;
TRUNCATE TABLE serial_numbers;

TRUNCATE TABLE stock_audit_items;
TRUNCATE TABLE stock_audits;

TRUNCATE TABLE consumption_items;
TRUNCATE TABLE consumption_entries;

TRUNCATE TABLE approval_history;
TRUNCATE TABLE approval_requests;

TRUNCATE TABLE notifications;
TRUNCATE TABLE activity_logs;
TRUNCATE TABLE scan_logs;
TRUNCATE TABLE email_logs;

TRUNCATE TABLE landed_cost_allocations;
TRUNCATE TABLE landed_costs;

TRUNCATE TABLE journal_entry_lines;
TRUNCATE TABLE journal_entries;
TRUNCATE TABLE account_ledger;

TRUNCATE TABLE gate_passes;
TRUNCATE TABLE asset_movements;
TRUNCATE TABLE demand_forecasts;
TRUNCATE TABLE file_attachments;
TRUNCATE TABLE barcode_registry;

SET FOREIGN_KEY_CHECKS=1;
