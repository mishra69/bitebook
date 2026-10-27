-- What an API run asked the provider for, besides the prompt and photos (D33): model,
-- reasoning effort, output format, token cap, how photos were sent. With prompt_text and the
-- stored display copies, it makes each batch a complete record of the request. JSON; null
-- for chat batches and for API runs before this.
ALTER TABLE batches ADD COLUMN request_params TEXT;
