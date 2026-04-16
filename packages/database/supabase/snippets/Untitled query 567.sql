-- =============================================================================
-- Move sync_purchase_invoice_line_price_change from BEFORE to AFTER interceptor.
--
-- unitPrice on purchaseInvoiceLine is a GENERATED STORED column. In PostgreSQL,
-- generated columns are not populated in NEW during BEFORE triggers, so the
-- interceptor saw NEW."unitPrice" as NULL and violated the NOT NULL constraint
-- on purchaseInvoicePriceChange."newPrice". Running the interceptor AFTER the
-- row is finalized restores the original legacy-trigger semantics.
-- =============================================================================

SELECT attach_event_trigger('purchaseInvoiceLine',
  ARRAY[]::TEXT[],
  ARRAY['sync_purchase_invoice_line_price_change']::TEXT[]
);
