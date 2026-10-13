ALTER TABLE "company_skill_sources" DROP CONSTRAINT "company_skill_sources_connection_id_tool_connections_id_fk";
--> statement-breakpoint
ALTER TABLE "company_skill_sources" DROP CONSTRAINT "company_skill_sources_refresh_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "project_skill_sources" DROP CONSTRAINT "project_skill_sources_refresh_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "project_skill_sources" DROP CONSTRAINT "project_skill_sources_connection_id_tool_connections_id_fk";
