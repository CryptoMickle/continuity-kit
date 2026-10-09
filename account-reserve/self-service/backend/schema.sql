CREATE TABLE `ss_capabilities` (
	`namespace` text NOT NULL,
	`capability_hash` text NOT NULL,
	`expires_ms` integer NOT NULL,
	PRIMARY KEY(`namespace`, `capability_hash`),
	FOREIGN KEY (`namespace`) REFERENCES `ss_release`(`namespace`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ss_capability_hash" CHECK(length("ss_capabilities"."capability_hash") = 64 AND "ss_capabilities"."capability_hash" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "ss_capability_expiry" CHECK(typeof("ss_capabilities"."expires_ms") = 'integer' AND "ss_capabilities"."expires_ms" > 0)
);
--> statement-breakpoint
CREATE TABLE `ss_records` (
	`namespace` text NOT NULL,
	`locator` text NOT NULL,
	`capability_hash` text NOT NULL,
	`ciphertext` text NOT NULL,
	PRIMARY KEY(`namespace`, `locator`),
	FOREIGN KEY (`namespace`,`capability_hash`) REFERENCES `ss_capabilities`(`namespace`,`capability_hash`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ss_record_locator" CHECK(length("ss_records"."locator") = 43 AND "ss_records"."locator" NOT GLOB '*[^A-Za-z0-9_-]*'),
	CONSTRAINT "ss_record_bytes" CHECK(length("ss_records"."ciphertext") BETWEEN 2 AND 87382 AND "ss_records"."ciphertext" NOT GLOB '*[^A-Za-z0-9_-]*')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ss_record_capability_unique` ON `ss_records` (`namespace`,`capability_hash`);--> statement-breakpoint
CREATE TABLE `ss_release` (
	`id` integer PRIMARY KEY NOT NULL,
	`namespace` text NOT NULL,
	`schema` text NOT NULL,
	`expires_ms` integer NOT NULL,
	`purged_ms` integer,
	CONSTRAINT "ss_release_singleton" CHECK("ss_release"."id" = 1),
	CONSTRAINT "ss_release_schema" CHECK("ss_release"."schema" = 'continuity-judge-ciphertext/v1'),
	CONSTRAINT "ss_release_expiry" CHECK(typeof("ss_release"."expires_ms") = 'integer' AND "ss_release"."expires_ms" > 0),
	CONSTRAINT "ss_release_purge" CHECK("ss_release"."purged_ms" IS NULL OR (typeof("ss_release"."purged_ms") = 'integer' AND "ss_release"."purged_ms" >= "ss_release"."expires_ms"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ss_release_namespace_unique` ON `ss_release` (`namespace`);