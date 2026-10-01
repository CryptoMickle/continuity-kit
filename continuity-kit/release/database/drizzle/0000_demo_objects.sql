CREATE TABLE `ck_demo_objects` (
	`slot` integer NOT NULL,
	`kind` text NOT NULL,
	`object_key` text NOT NULL,
	`bytes` blob NOT NULL,
	PRIMARY KEY(`slot`, `kind`, `object_key`),
	CONSTRAINT "ck_demo_slot" CHECK("ck_demo_objects"."slot" IN (0,1)),
	CONSTRAINT "ck_demo_kind" CHECK("ck_demo_objects"."kind" IN ('index','blob')),
	CONSTRAINT "ck_demo_bytes" CHECK(length("ck_demo_objects"."bytes") > 0 AND length("ck_demo_objects"."bytes") <= 1048576)
);
