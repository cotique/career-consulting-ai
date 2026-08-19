// AuthGuard attaches the authenticated user id to the request.
declare global {
  namespace Express {
    interface Request {
      userId?: string;
    }
  }
}

export {};
