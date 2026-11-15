-- BeFreed fork: Schedules may run every occurrence in a fresh provider conversation (agent_schedules.fresh_session,
-- default false). The scheduled message origin may then carry `freshSession: true`, so the source-shape check is
-- widened by exactly that one optional key. The new check is strictly looser than the old one (every existing row
-- still satisfies it); it is added NOT VALID then validated, to keep the lock on session_messages short.
ALTER TABLE "session_messages" DROP CONSTRAINT "session_messages_source_shape";--> statement-breakpoint
ALTER TABLE "agent_schedules" ADD COLUMN "fresh_session" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "session_messages" ADD CONSTRAINT "session_messages_source_shape" CHECK (("session_messages"."source_session_id" is not null and "session_messages"."scheduled_origin" is null)
        or ("session_messages"."source_session_id" is null
          and "session_messages"."scheduled_origin" is not null
          and jsonb_typeof("session_messages"."scheduled_origin") = 'object'
          and "session_messages"."scheduled_origin" ?& array['scheduleId', 'scheduledFor', 'timezone', 'name']
          and ("session_messages"."scheduled_origin" - 'scheduleId' - 'scheduledFor' - 'timezone' - 'name' - 'freshSession') = '{}'::jsonb
          and (not ("session_messages"."scheduled_origin" ? 'freshSession') or "session_messages"."scheduled_origin"->'freshSession' = 'true'::jsonb)
          and jsonb_typeof("session_messages"."scheduled_origin"->'scheduleId') = 'string'
          and "session_messages"."scheduled_origin"->>'scheduleId' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
          and jsonb_typeof("session_messages"."scheduled_origin"->'scheduledFor') = 'string'
          and length("session_messages"."scheduled_origin"->>'scheduledFor') > 0
          and jsonb_typeof("session_messages"."scheduled_origin"->'timezone') = 'string'
          and length("session_messages"."scheduled_origin"->>'timezone') > 0
          and jsonb_typeof("session_messages"."scheduled_origin"->'name') = 'string'
          and char_length("session_messages"."scheduled_origin"->>'name') between 1 and 120)) NOT VALID;--> statement-breakpoint
ALTER TABLE "session_messages" VALIDATE CONSTRAINT "session_messages_source_shape";
