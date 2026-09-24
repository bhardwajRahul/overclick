ALTER TABLE "mcp_token" ADD COLUMN "owner_user_id" uuid;--> statement-breakpoint
ALTER TABLE "mission" ADD COLUMN "created_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "role" text DEFAULT 'member' NOT NULL;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "organization_id" uuid;--> statement-breakpoint
ALTER TABLE "mcp_token" ADD CONSTRAINT "mcp_token_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mission" ADD CONSTRAINT "mission_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user" ADD CONSTRAINT "user_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE set null ON UPDATE no action;
-- OCL-219: everyone who exists before members do is an admin (the signup
-- closes after the first user, so today that is exactly one person), and every
-- token that exists belongs to an admin: the one who made it, or else the
-- oldest one. Cards and missions keep a null author on purpose: for a member
-- they do not exist.
UPDATE "user" SET "role" = 'admin';--> statement-breakpoint
UPDATE "mcp_token" t
SET "owner_user_id" = COALESCE(
  t."created_by_user_id",
  (SELECT u."id" FROM "user" u ORDER BY u."created_at" ASC, u."id" ASC LIMIT 1)
);
