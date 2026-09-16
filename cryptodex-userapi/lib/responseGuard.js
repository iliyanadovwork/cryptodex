/**
 * Response guarantee middleware.
 *
 * Several legacy controllers in this service `catch` an error, log it, and then
 * fall off the end of the function without ever calling `res.*`. Express has no
 * way to notice that: the request handler resolves, nothing is written, and the
 * socket is held open until the client gives up. Unauthenticated routes with
 * this shape are a free connection-exhaustion primitive (see the old
 * GET /api/admin/getAdminBal, which threw a ReferenceError on every call).
 *
 * Individual handlers have been fixed, but this middleware is the structural
 * backstop so that a future handler with the same bug degrades into a 500
 * instead of a leaked connection.
 *
 * Note this deliberately does NOT abort the underlying work; it only guarantees
 * that the HTTP response is terminated.
 *
 * @param {number} timeoutMs how long to wait before force-closing the response
 */
export const responseGuard = (timeoutMs = 30000) => {
  return (req, res, next) => {
    const timer = setTimeout(() => {
      if (res.headersSent || res.writableEnded) {
        return;
      }
      console.error(
        `[responseGuard] no response after ${timeoutMs}ms for ${req.method} ${req.originalUrl} - forcing 500`
      );
      try {
        res.status(500).json({ success: false, message: "Error on server" });
      } catch (err) {
        try {
          res.end();
        } catch (_) {
          /* socket already gone */
        }
      }
    }, timeoutMs);

    // Never keep the process alive just for the guard.
    if (typeof timer.unref === "function") {
      timer.unref();
    }

    const clear = () => clearTimeout(timer);
    res.on("finish", clear);
    res.on("close", clear);

    return next();
  };
};

export default responseGuard;
