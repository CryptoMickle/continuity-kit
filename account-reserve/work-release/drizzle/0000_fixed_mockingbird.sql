CREATE TABLE `work_records` (
	`namespace` text NOT NULL,
	`locator` text NOT NULL,
	`ticket_hash` text NOT NULL,
	`ciphertext` text NOT NULL,
	PRIMARY KEY(`namespace`, `locator`),
	FOREIGN KEY (`namespace`) REFERENCES `work_releases`(`namespace`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "record_locator" CHECK(length("work_records"."locator") = 43 AND "work_records"."locator" NOT GLOB '*[^A-Za-z0-9_-]*'),
	CONSTRAINT "record_ticket" CHECK(length("work_records"."ticket_hash") = 64 AND "work_records"."ticket_hash" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "record_bytes" CHECK(length("work_records"."ciphertext") BETWEEN 2 AND 87382 AND "work_records"."ciphertext" NOT GLOB '*[^A-Za-z0-9_-]*')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `work_record_ticket` ON `work_records` (`namespace`,`ticket_hash`);--> statement-breakpoint
CREATE TABLE `work_releases` (
	`namespace` text PRIMARY KEY NOT NULL,
	`schema` text NOT NULL,
	`expires_ms` integer NOT NULL,
	`purged_ms` integer,
	CONSTRAINT "release_schema" CHECK("work_releases"."schema" = 'account-reserve-ciphertext/v1'),
	CONSTRAINT "release_expiry" CHECK(typeof("work_releases"."expires_ms") = 'integer' AND "work_releases"."expires_ms" > 0),
	CONSTRAINT "release_purge" CHECK("work_releases"."purged_ms" IS NULL OR (typeof("work_releases"."purged_ms") = 'integer' AND "work_releases"."purged_ms" >= "work_releases"."expires_ms"))
);
