-- =============================================================================
-- Fix Embedding Triggers
-- The search-refactor migration (20260109) dropped trigger functions that had
-- dual responsibility: updating the old search table AND queuing embedding jobs.
-- The new async search system replaced search indexing but did not re-add the
-- embedding pipeline. This migration creates standalone embedding triggers.
-- =============================================================================

-- Queue embedding on item insert
CREATE OR REPLACE FUNCTION queue_item_embedding()
RETURNS TRIGGER AS $$
BEGIN
  PERFORM util.queue_embeddings(NEW.id, 'item');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Queue embedding on item update (only when name or description changes)
CREATE OR REPLACE FUNCTION queue_item_embedding_on_update()
RETURNS TRIGGER AS $$
BEGIN
  IF (OLD.name IS DISTINCT FROM NEW.name OR OLD.description IS DISTINCT FROM NEW.description) THEN
    NEW.embedding = NULL;
    PERFORM util.queue_embeddings(NEW.id, 'item');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Queue embedding on customer insert
CREATE OR REPLACE FUNCTION queue_customer_embedding()
RETURNS TRIGGER AS $$
BEGIN
  PERFORM util.queue_embeddings(NEW.id, 'customer');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Queue embedding on customer update (only when name changes)
CREATE OR REPLACE FUNCTION queue_customer_embedding_on_update()
RETURNS TRIGGER AS $$
BEGIN
  IF (OLD.name IS DISTINCT FROM NEW.name) THEN
    NEW.embedding = NULL;
    PERFORM util.queue_embeddings(NEW.id, 'customer');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Queue embedding on supplier insert
CREATE OR REPLACE FUNCTION queue_supplier_embedding()
RETURNS TRIGGER AS $$
BEGIN
  PERFORM util.queue_embeddings(NEW.id, 'supplier');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Queue embedding on supplier update (only when name changes)
CREATE OR REPLACE FUNCTION queue_supplier_embedding_on_update()
RETURNS TRIGGER AS $$
BEGIN
  IF (OLD.name IS DISTINCT FROM NEW.name) THEN
    NEW.embedding = NULL;
    PERFORM util.queue_embeddings(NEW.id, 'supplier');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Attach triggers
CREATE TRIGGER queue_item_embedding
  BEFORE INSERT ON "item"
  FOR EACH ROW
  EXECUTE FUNCTION queue_item_embedding();

CREATE TRIGGER queue_item_embedding_on_update
  BEFORE UPDATE ON "item"
  FOR EACH ROW
  EXECUTE FUNCTION queue_item_embedding_on_update();

CREATE TRIGGER queue_customer_embedding
  BEFORE INSERT ON "customer"
  FOR EACH ROW
  EXECUTE FUNCTION queue_customer_embedding();

CREATE TRIGGER queue_customer_embedding_on_update
  BEFORE UPDATE ON "customer"
  FOR EACH ROW
  EXECUTE FUNCTION queue_customer_embedding_on_update();

CREATE TRIGGER queue_supplier_embedding
  BEFORE INSERT ON "supplier"
  FOR EACH ROW
  EXECUTE FUNCTION queue_supplier_embedding();

CREATE TRIGGER queue_supplier_embedding_on_update
  BEFORE UPDATE ON "supplier"
  FOR EACH ROW
  EXECUTE FUNCTION queue_supplier_embedding_on_update();

