-- 0007: human-readable case numbers (INC-1001, INC-1002, ...). Owner request 2026-11-07.
-- Additive: an identity column filled for existing rows and assigned on every
-- insert (including alert ingestion). Unique and never reused. Previous code
-- does not insert it, so it keeps working.

ALTER TABLE incidents ADD COLUMN number bigint GENERATED ALWAYS AS IDENTITY (START WITH 1001);
ALTER TABLE incidents ADD CONSTRAINT incidents_number_key UNIQUE (number);
