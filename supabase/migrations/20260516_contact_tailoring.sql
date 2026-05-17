-- Per-contact tailoring fields generated at Stage 3 time alongside contact
-- discovery. Both are short SDR-facing strings (the prospect never sees them).
--
--   outreach_angle:   one sentence on why THIS specific contact is the right
--                     person to pitch GovSpend to, given their title + the
--                     company's industry/value-driver.
--   likely_challenge: one sentence on the GovSpend-relevant pain they're
--                     probably facing, used to focus the email/voicemail.
--
-- Cached on contacts with the same 30-day TTL as the rest of contact data —
-- when the contact list refreshes, these refresh too.
alter table public.contacts add column if not exists outreach_angle text;
alter table public.contacts add column if not exists likely_challenge text;
