-- Contact discovery is moving from a fallback chain (one provider wins,
-- source is a single string) to aggregation across multiple providers in
-- parallel (a contact can be found by ZoomInfo AND LinkedIn AND Company-
-- Website at once; provenance is a set, not a winner). Replace the single
-- `source` text column with a `sources` text[] array.
--
-- Order matters: add the new column first, backfill from the old one so any
-- existing rows keep their provenance, then drop the old column.
alter table public.contacts add column if not exists sources text[];
update public.contacts
   set sources = ARRAY[source]
 where source is not null
   and (sources is null or array_length(sources, 1) is null);
alter table public.contacts drop column if exists source;
