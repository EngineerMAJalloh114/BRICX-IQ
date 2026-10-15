CREATE FUNCTION bricx.fx_later() RETURNS integer LANGUAGE sql STABLE BEGIN ATOMIC SELECT 1; END;
--> statement-breakpoint
CREATE FUNCTION bricx.fx_definer() RETURNS integer LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp BEGIN ATOMIC SELECT 2; END;
