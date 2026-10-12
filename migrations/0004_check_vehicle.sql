-- Vehicle identity snapshot for history list display (replaces the timestamp there).
-- Rows recorded before this migration keep NULL; the client renders vehicle
-- info only when present.
ALTER TABLE check_logs ADD COLUMN vehicle_brand TEXT;
ALTER TABLE check_logs ADD COLUMN vehicle_type TEXT;
ALTER TABLE check_logs ADD COLUMN vehicle_color TEXT;
