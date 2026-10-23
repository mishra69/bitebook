-- Fiber per serving for remembered foods (prompt/7, D22). Meals keep fiber in the
-- analysis payload, like the other numbers; foods written before this have none.
ALTER TABLE foods ADD COLUMN fiber_g REAL;
