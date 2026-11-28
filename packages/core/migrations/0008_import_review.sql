-- M2 step 4 (D-70): the import plan's review flags on imported drafts (admin-only).
ALTER TABLE `items` ADD `import_review` text;