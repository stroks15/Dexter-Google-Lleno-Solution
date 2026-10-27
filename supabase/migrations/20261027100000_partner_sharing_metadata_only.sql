-- Statuses for metadata-only Google Photos Partner Sharing workflow.
-- The workflow deliberately never marks photos safe to delete.
alter type public.dexter_google_migration_status add value if not exists 'awaiting_partner_sharing';
alter type public.dexter_google_migration_status add value if not exists 'manual_verification_required';
