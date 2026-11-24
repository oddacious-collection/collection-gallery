CREATE TABLE `media_uploads` (
	`id` text PRIMARY KEY NOT NULL,
	`item_id` text NOT NULL,
	`parts` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `media_uploads_created_idx` ON `media_uploads` (`created_at`);