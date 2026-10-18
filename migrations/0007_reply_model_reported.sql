-- What the model said about itself in its reply (prompt/3, D17). batches.reply_model is
-- what the user confirmed; this is the raw self-report, kept for comparison.
ALTER TABLE batches ADD COLUMN reply_model_reported TEXT;
