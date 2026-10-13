CREATE TABLE "project_skill_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"workspace_id" uuid,
	"source_id" uuid,
	"repository_url" text NOT NULL,
	"tracking_ref" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"refresh_user_id" text,
	"refresh_agent_id" uuid,
	"refresh_local_trusted" boolean DEFAULT false NOT NULL,
	"connection_id" uuid,
	"refresh_grant_id" uuid,
	"next_sync_at" timestamp with time zone DEFAULT now() NOT NULL,
	"failure_count" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"lease_token" uuid,
	"lease_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "company_skill_sources" ADD COLUMN "automatic_updates" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "company_skill_sources" ADD COLUMN "import_new_skills" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "company_skill_sources" ADD COLUMN "access_scope" text DEFAULT 'company' NOT NULL;--> statement-breakpoint
ALTER TABLE "company_skill_sources" ADD COLUMN "refresh_user_id" text;--> statement-breakpoint
ALTER TABLE "company_skill_sources" ADD COLUMN "refresh_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "company_skill_sources" ADD COLUMN "refresh_local_trusted" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "company_skill_sources" ADD COLUMN "refresh_grant_id" uuid;--> statement-breakpoint
ALTER TABLE "company_skill_sources" ADD COLUMN "next_sync_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "company_skill_sources" ADD COLUMN "failure_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "company_skills" ADD COLUMN "access_source_id" uuid;--> statement-breakpoint
ALTER TABLE "project_skill_sources" ADD CONSTRAINT "project_skill_sources_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_skill_sources" ADD CONSTRAINT "project_skill_sources_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_skill_sources" ADD CONSTRAINT "project_skill_sources_workspace_id_project_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."project_workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_skill_sources" ADD CONSTRAINT "project_skill_sources_source_id_company_skill_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."company_skill_sources"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_skill_sources" ADD CONSTRAINT "project_skill_sources_refresh_agent_id_agents_id_fk" FOREIGN KEY ("refresh_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_skill_sources" ADD CONSTRAINT "project_skill_sources_connection_id_tool_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."tool_connections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "project_skill_sources_workspace_repo_ref_idx" ON "project_skill_sources" USING btree ("workspace_id","repository_url","tracking_ref");--> statement-breakpoint
CREATE INDEX "project_skill_sources_source_project_idx" ON "project_skill_sources" USING btree ("company_id","source_id","project_id");--> statement-breakpoint
CREATE INDEX "project_skill_sources_sync_idx" ON "project_skill_sources" USING btree ("active","status","next_sync_at");--> statement-breakpoint
ALTER TABLE "company_skill_sources" ADD CONSTRAINT "company_skill_sources_refresh_agent_id_agents_id_fk" FOREIGN KEY ("refresh_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;