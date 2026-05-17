-- Stage 4 expansion: generate exec/manager/IC variants for email, voicemail,
-- and SMS instead of one email per row. Each JSONB column is keyed by tier
-- ("exec" | "manager" | "ic"); a tier is only present if we had a contact at
-- that level to address.
--
-- Existing email_subject / email_body columns are preserved and continue to
-- hold the exec variant (or fallback: manager, then ic) so older UI surfaces
-- keep working without a forced migration.
--
-- Shape:
--   email_variants:     { exec: { subject, body }, manager: { ... }, ic: { ... } }
--   voicemail_variants: { exec: "spoken script", manager: "...", ic: "..." }
--   sms_variants:       { exec: "short text", manager: "...", ic: "..." }
alter table public.run_accounts add column if not exists email_variants jsonb;
alter table public.run_accounts add column if not exists voicemail_variants jsonb;
alter table public.run_accounts add column if not exists sms_variants jsonb;
