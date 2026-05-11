-- Async task delegation columns for job_queue

ALTER TABLE job_queue ADD COLUMN IF NOT EXISTS delegated_by TEXT;
ALTER TABLE job_queue ADD COLUMN IF NOT EXISTS callback_url TEXT;
