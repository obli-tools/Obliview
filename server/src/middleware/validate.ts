import type { Request, Response, NextFunction } from 'express';
import type { ZodSchema } from 'zod';

export function validate(schema: ZodSchema, source: 'body' | 'query' | 'params' = 'body') {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req[source]);

    if (!result.success) {
      // Flatten the Zod issue tree into a single human-readable summary
      // ("Validation failed - name: Required; port: Expected number") so the
      // UI toast says what is wrong instead of an opaque "Validation failed".
      // The structured `details` field is kept for clients that render
      // per-field errors.
      const issues = result.error.errors.map((e) => {
        const path = e.path.length ? e.path.join('.') : '<root>';
        return `${path}: ${e.message}`;
      });
      res.status(400).json({
        success: false,
        error: issues.length > 0 ? `Validation failed - ${issues.join('; ')}` : 'Validation failed',
        details: result.error.flatten().fieldErrors,
      });
      return;
    }

    req[source] = result.data;
    next();
  };
}
