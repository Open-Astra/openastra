-- StatSniper beat reporters: seed scheduled_agents for daily 7am PDT (14:00 UTC) execution
-- Each agent runs once daily, searches for the day's top story, and publishes to Sanity CMS.

INSERT INTO scheduled_agents (agent_id, cron_expression, input_message, surface, surface_id, enabled, created_by)
VALUES
  ('statsniper_nba', '0 14 * * *',
   'Find today''s single most important NBA story. Research it thoroughly using web search, then write and publish a 1100-1300 word article to Sanity CMS.',
   'scheduled', 'statsniper-nba-daily', true, 'system'),

  ('statsniper_nhl', '0 14 * * *',
   'Find today''s single most important NHL story. Research it thoroughly using web search, then write and publish a 1100-1300 word article to Sanity CMS.',
   'scheduled', 'statsniper-nhl-daily', true, 'system'),

  ('statsniper_mlb', '0 14 * * *',
   'Find today''s single most important MLB story. Research it thoroughly using web search, then write and publish a 1100-1300 word article to Sanity CMS.',
   'scheduled', 'statsniper-mlb-daily', true, 'system'),

  ('statsniper_mls', '0 14 * * *',
   'Find today''s single most important MLS story. Research it thoroughly using web search, then write and publish a 1100-1300 word article to Sanity CMS.',
   'scheduled', 'statsniper-mls-daily', true, 'system'),

  ('statsniper_nfl', '0 14 * * *',
   'Find today''s single most important NFL story. Research it thoroughly using web search, then write and publish a 1100-1300 word article to Sanity CMS.',
   'scheduled', 'statsniper-nfl-daily', true, 'system'),

  ('statsniper_epl', '0 14 * * *',
   'Find today''s single most important EPL story. Research it thoroughly using web search, then write and publish a 1100-1300 word article to Sanity CMS.',
   'scheduled', 'statsniper-epl-daily', true, 'system')

ON CONFLICT DO NOTHING;
