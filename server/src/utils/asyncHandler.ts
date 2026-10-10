import type { Request, Response, NextFunction, RequestHandler } from 'express';

/**
 * Express 4 does not catch rejected promises returned by async handlers: an
 * error thrown after an `await` becomes an unhandled rejection, which exits
 * the process on Node >= 15. Wrapping a handler with asyncHandler forwards
 * the rejection to next(err), so the global errorHandler answers instead.
 */
export const asyncHandler = <Req extends Request = Request>(
  fn: (req: Req, res: Response, next: NextFunction) => unknown,
): RequestHandler =>
  (req, res, next) => {
    Promise.resolve(fn(req as Req, res, next)).catch(next);
  };
