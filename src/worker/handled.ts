// Whether a meal is done with analysis (D51): it has an estimate the model counted, or one
// it chose to skip (a duplicate, an unusable photo), unless the user asked to analyze it
// again after that skip. A skipped meal counts for nothing but no longer waits.
// Use with ?1 bound to the user's id and `m` the meals row's alias.
export const HANDLED = (m = "m") =>
  `EXISTS (SELECT 1 FROM analyses a WHERE a.user_id = ?1 AND a.meal_id = ${m}.id
     AND (a.skipped = 0 OR ${m}.reanalyze_at IS NULL OR a.created_at > ${m}.reanalyze_at))`;
