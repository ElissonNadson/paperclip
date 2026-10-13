DROP INDEX "company_skill_sources_repository_ref_idx";--> statement-breakpoint
DROP INDEX "company_skill_sources_identity_ref_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "company_skill_sources_repository_ref_idx" ON "company_skill_sources" USING btree ("company_id","repository_url","tracking_ref") WHERE "company_skill_sources"."removed_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "company_skill_sources_identity_ref_idx" ON "company_skill_sources" USING btree ("company_id","repository_id","tracking_ref") WHERE "company_skill_sources"."removed_at" is null;