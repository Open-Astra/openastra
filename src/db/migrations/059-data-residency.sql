CREATE TABLE IF NOT EXISTS workspace_data_policies (
  workspace_id UUID PRIMARY KEY,
  allowed_regions TEXT[] NOT NULL DEFAULT '{}',
  allowed_providers TEXT[] NOT NULL DEFAULT '{grok,groq,openai,gemini,claude,ollama,vllm,openrouter,mistral,bedrock}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
