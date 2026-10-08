/**
 * `validate(schema)` middleware: parses `{ body, query, params }` against a zod
 * schema and stores the parsed, coerced result in `res.locals.validated`. On a
 * zod failure it responds `400 { error: { code: 'VALIDATION', message } }` with
 * a human-readable issue summary. Nothing reaches a route handler unvalidated.
 */

import type { NextFunction, Request, Response } from 'express';
import { ZodError, type ZodTypeAny } from 'zod';

/** Reads the validated payload a route handler relies on. */
export function validated<T>(res: Response): T {
  return res.locals.validated as T;
}

function summarize(err: ZodError): string {
  return err.issues
    .map((i) => {
      const where = i.path.join('.');
      return where ? `${where}: ${i.message}` : i.message;
    })
    .join('; ');
}

export function validate(schema: ZodTypeAny) {
  return function validateMiddleware(req: Request, res: Response, next: NextFunction): void {
    const result = schema.safeParse({
      body: req.body,
      query: req.query,
      params: req.params,
    });
    if (!result.success) {
      res.status(400).json({
        error: { code: 'VALIDATION', message: summarize(result.error) },
      });
      return;
    }
    res.locals.validated = result.data;
    next();
  };
}
