CREATE TABLE `media_upload_chunks` (
	`upload_id` text NOT NULL,
	`part` text NOT NULL,
	`n` integer NOT NULL,
	`etag` text NOT NULL,
	`bytes` integer NOT NULL,
	PRIMARY KEY(`upload_id`, `part`, `n`),
	FOREIGN KEY (`upload_id`) REFERENCES `media_uploads`(`id`) ON UPDATE no action ON DELETE cascade
);
