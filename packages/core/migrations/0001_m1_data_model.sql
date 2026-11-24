CREATE TABLE `analytics_daily` (
	`date` text NOT NULL,
	`item_id` text DEFAULT '' NOT NULL,
	`metric` text NOT NULL,
	`country` text DEFAULT '' NOT NULL,
	`region` text DEFAULT '' NOT NULL,
	`referrer_host` text DEFAULT '' NOT NULL,
	`count` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`date`, `item_id`, `metric`, `country`, `region`, `referrer_host`),
	CONSTRAINT "analytics_daily_metric_check" CHECK("analytics_daily"."metric" IN ('view', 'like'))
);
--> statement-breakpoint
CREATE TABLE `audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`at` text NOT NULL,
	`actor_email` text NOT NULL,
	`action` text NOT NULL,
	`target_type` text NOT NULL,
	`target_id` text NOT NULL,
	`details` text DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `audit_log_at_idx` ON `audit_log` (`at`);--> statement-breakpoint
CREATE INDEX `audit_log_target_idx` ON `audit_log` (`target_type`,`target_id`);--> statement-breakpoint
CREATE TABLE `categories` (
	`id` text PRIMARY KEY NOT NULL,
	`parent_id` text,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`cover_media_id` text,
	`default_license` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`parent_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`cover_media_id`) REFERENCES `media`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "categories_license_check" CHECK("categories"."default_license" IS NULL OR "categories"."default_license" IN ('cc-by', 'cc-by-nc', 'cc-by-nc-sa', 'cc-by-nc-nd', 'arr')),
	CONSTRAINT "categories_not_own_parent" CHECK("categories"."parent_id" IS NULL OR "categories"."parent_id" <> "categories"."id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `categories_slug_unique` ON `categories` (`slug`);--> statement-breakpoint
CREATE INDEX `categories_parent_idx` ON `categories` (`parent_id`,`position`);--> statement-breakpoint
CREATE TABLE `category_closure` (
	`ancestor_id` text NOT NULL,
	`descendant_id` text NOT NULL,
	`depth` integer NOT NULL,
	PRIMARY KEY(`ancestor_id`, `descendant_id`),
	FOREIGN KEY (`ancestor_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`descendant_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `category_closure_descendant_idx` ON `category_closure` (`descendant_id`);--> statement-breakpoint
CREATE TABLE `documents` (
	`id` text PRIMARY KEY NOT NULL,
	`item_id` text NOT NULL,
	`provenance_event_id` text,
	`key` text NOT NULL,
	`filename` text NOT NULL,
	`mime` text NOT NULL,
	`size` integer NOT NULL,
	`created_at` text NOT NULL,
	`deleted_at` text,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`provenance_event_id`) REFERENCES `provenance_events`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `documents_key_unique` ON `documents` (`key`);--> statement-breakpoint
CREATE INDEX `documents_item_idx` ON `documents` (`item_id`);--> statement-breakpoint
CREATE TABLE `field_definitions` (
	`id` text PRIMARY KEY NOT NULL,
	`category_id` text NOT NULL,
	`key` text NOT NULL,
	`label` text NOT NULL,
	`type` text NOT NULL,
	`options` text,
	`visibility` text DEFAULT 'admin' NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "field_definitions_type_check" CHECK("field_definitions"."type" IN ('text', 'long_text', 'number', 'date', 'bool', 'select', 'url')),
	CONSTRAINT "field_definitions_visibility_check" CHECK("field_definitions"."visibility" IN ('public', 'admin'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `field_definitions_category_key_unique` ON `field_definitions` (`category_id`,`key`);--> statement-breakpoint
CREATE TABLE `item_categories` (
	`item_id` text NOT NULL,
	`category_id` text NOT NULL,
	PRIMARY KEY(`item_id`, `category_id`),
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `item_categories_category_idx` ON `item_categories` (`category_id`);--> statement-breakpoint
CREATE TABLE `item_field_values` (
	`item_id` text NOT NULL,
	`field_id` text NOT NULL,
	`value` text NOT NULL,
	PRIMARY KEY(`item_id`, `field_id`),
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`field_id`) REFERENCES `field_definitions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `item_revisions` (
	`id` text PRIMARY KEY NOT NULL,
	`item_id` text NOT NULL,
	`snapshot` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `item_revisions_item_idx` ON `item_revisions` (`item_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `item_tags` (
	`item_id` text NOT NULL,
	`tag_id` text NOT NULL,
	PRIMARY KEY(`item_id`, `tag_id`),
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tag_id`) REFERENCES `tags`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `item_tags_tag_idx` ON `item_tags` (`tag_id`);--> statement-breakpoint
CREATE TABLE `items` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`kind` text DEFAULT 'owned' NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`title` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`posted_at` text,
	`license_override` text,
	`watermark_override` text DEFAULT 'inherit' NOT NULL,
	`purchase_price_cents` integer,
	`purchase_currency` text,
	`purchase_date` text,
	`open_to_parting` integer DEFAULT false NOT NULL,
	`source_caption` text,
	`suggested_tags` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`deleted_at` text,
	CONSTRAINT "items_kind_check" CHECK("items"."kind" IN ('owned', 'wishlist')),
	CONSTRAINT "items_status_check" CHECK("items"."status" IN ('draft', 'public', 'private')),
	CONSTRAINT "items_watermark_check" CHECK("items"."watermark_override" IN ('inherit', 'on', 'off')),
	CONSTRAINT "items_license_check" CHECK("items"."license_override" IS NULL OR "items"."license_override" IN ('cc-by', 'cc-by-nc', 'cc-by-nc-sa', 'cc-by-nc-nd', 'arr')),
	CONSTRAINT "items_price_check" CHECK("items"."purchase_price_cents" IS NULL OR "items"."purchase_price_cents" >= 0),
	CONSTRAINT "items_currency_check" CHECK("items"."purchase_currency" IS NULL OR length("items"."purchase_currency") = 3),
	CONSTRAINT "items_wishlist_not_public" CHECK(NOT ("items"."kind" = 'wishlist' AND "items"."status" = 'public'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `items_slug_unique` ON `items` (`slug`);--> statement-breakpoint
CREATE INDEX `items_visibility_idx` ON `items` (`status`,`kind`,`deleted_at`,`posted_at`);--> statement-breakpoint
CREATE INDEX `items_deleted_idx` ON `items` (`deleted_at`);--> statement-breakpoint
CREATE TABLE `like_dedupe` (
	`date` text NOT NULL,
	`item_id` text NOT NULL,
	`hash` text NOT NULL,
	PRIMARY KEY(`date`, `item_id`, `hash`)
);
--> statement-breakpoint
CREATE TABLE `media` (
	`id` text PRIMARY KEY NOT NULL,
	`item_id` text NOT NULL,
	`position` integer NOT NULL,
	`is_cover` integer DEFAULT false NOT NULL,
	`kind` text NOT NULL,
	`original_key` text NOT NULL,
	`width` integer NOT NULL,
	`height` integer NOT NULL,
	`duration_s` real,
	`has_audio` integer DEFAULT false NOT NULL,
	`captions_key` text,
	`alt_text` text DEFAULT '' NOT NULL,
	`content_hash` text,
	`created_at` text NOT NULL,
	`deleted_at` text,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "media_kind_check" CHECK("media"."kind" IN ('image', 'video')),
	CONSTRAINT "media_dimensions_check" CHECK("media"."width" > 0 AND "media"."height" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `media_original_key_unique` ON `media` (`original_key`);--> statement-breakpoint
CREATE INDEX `media_item_idx` ON `media` (`item_id`,`position`);--> statement-breakpoint
CREATE INDEX `media_hash_idx` ON `media` (`content_hash`);--> statement-breakpoint
CREATE TABLE `media_variants` (
	`key` text PRIMARY KEY NOT NULL,
	`media_id` text NOT NULL,
	`role` text NOT NULL,
	`width` integer NOT NULL,
	`height` integer NOT NULL,
	`format` text NOT NULL,
	`bytes` integer NOT NULL,
	`watermarked` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`media_id`) REFERENCES `media`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "media_variants_role_check" CHECK("media_variants"."role" IN ('image', 'og', 'poster', 'video'))
);
--> statement-breakpoint
CREATE INDEX `media_variants_media_idx` ON `media_variants` (`media_id`);--> statement-breakpoint
CREATE TABLE `permission_grants` (
	`id` text PRIMARY KEY NOT NULL,
	`requester_name` text NOT NULL,
	`requester_email` text NOT NULL,
	`item_id` text,
	`media_id` text,
	`intended_use` text DEFAULT '' NOT NULL,
	`credit_line` text DEFAULT '' NOT NULL,
	`granted_on` text NOT NULL,
	`terms` text DEFAULT '' NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`media_id`) REFERENCES `media`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `permission_grants_item_idx` ON `permission_grants` (`item_id`);--> statement-breakpoint
CREATE TABLE `permission_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`received_at` text NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`item_id` text,
	`intended_use` text DEFAULT '' NOT NULL,
	`where_used` text DEFAULT '' NOT NULL,
	`credit_line` text DEFAULT '' NOT NULL,
	`message` text DEFAULT '' NOT NULL,
	`grant_id` text,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`grant_id`) REFERENCES `permission_grants`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `permission_requests_received_idx` ON `permission_requests` (`received_at`);--> statement-breakpoint
CREATE TABLE `provenance_events` (
	`id` text PRIMARY KEY NOT NULL,
	`item_id` text NOT NULL,
	`date` text NOT NULL,
	`type` text NOT NULL,
	`counterparty` text DEFAULT '' NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "provenance_events_type_check" CHECK("provenance_events"."type" IN ('acquired', 'gifted', 'appraised', 'restored', 'exhibited', 'other'))
);
--> statement-breakpoint
CREATE INDEX `provenance_events_item_idx` ON `provenance_events` (`item_id`,`date`);--> statement-breakpoint
CREATE TABLE `slug_redirects` (
	`old_slug` text PRIMARY KEY NOT NULL,
	`item_id` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `tags` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tags_slug_unique` ON `tags` (`slug`);--> statement-breakpoint
CREATE TABLE `valuations` (
	`id` text PRIMARY KEY NOT NULL,
	`item_id` text NOT NULL,
	`date` text NOT NULL,
	`value_cents` integer NOT NULL,
	`currency` text DEFAULT 'USD' NOT NULL,
	`source` text DEFAULT '' NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "valuations_value_check" CHECK("valuations"."value_cents" >= 0),
	CONSTRAINT "valuations_currency_check" CHECK(length("valuations"."currency") = 3)
);
--> statement-breakpoint
CREATE INDEX `valuations_item_idx` ON `valuations` (`item_id`,`date`);