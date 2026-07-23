-- Public share links for the per-work-center OEE TV board: an externalLink
-- row (documentType 'WorkCenter', documentId = workCenterId) resolves to the
-- unauthenticated board at /share/oee/:id (ERP share+ routes).
ALTER TYPE "externalLinkDocumentType" ADD VALUE IF NOT EXISTS 'WorkCenter';
