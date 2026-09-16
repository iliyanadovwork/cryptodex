/**
 * WHETHER THIS SERVICE'S gRPC SERVER IS ACTUALLY BOUND.
 *
 * walletapi listens on TWO sockets, and the HTTP one is the less important of
 * the pair. Every balance any other service reads or moves - spotapi's fills,
 * userapi's deactivation gate -
 * arrives over `grpc/server.js`. If that
 * socket never bound, the HTTP API is perfectly happy, the port checker is
 * perfectly happy, and the venue cannot trade.
 *
 * `grpc/server.js` binds asynchronously AFTER express is already listening
 * (server.js starts express, then `import('./grpc/server.js')`), so there is a
 * real window in which the process is up and this service is NOT ready. This
 * module is how the health endpoint can tell the difference, instead of
 * assuming.
 *
 * It holds three booleans and a port. It is a module-scope box on purpose:
 * grpc/server.js has no exports and no owner to inject into, and the health
 * controller must not import it (importing it would BIND THE SOCKET as a side
 * effect of a health check).
 */

const state = {
  /** bindAsync called back with a port and no error. */
  bound: false,
  /** The port the OS actually gave us - 0 is a real failure, not a default. */
  port: null,
  /** What we asked for, e.g. "127.0.0.1:6002". */
  address: null,
  /** bindAsync's error message, if it failed. */
  error: null,
  /** ISO timestamp of the last transition, for "how long has it been down". */
  changedAt: null,
};

/**
 * Called from grpc/server.js's bindAsync callback, with exactly what it was
 * handed. A bind that reports port 0 is treated as a FAILURE: grpc-js returns 0
 * when it could not bind, and reporting "bound on port 0" is the kind of green
 * light this whole endpoint exists to stop.
 */
export const recordGrpcBind = ({ address, port, error } = {}) => {
  state.address = address == null ? state.address : String(address);
  state.error = error ? String(error.message || error) : null;
  state.port = Number.isFinite(Number(port)) ? Number(port) : null;
  state.bound = !error && Number(port) > 0;
  state.changedAt = new Date().toISOString();
  return grpcServerState();
};

/** A copy, so a caller cannot mutate the record by holding it. */
export const grpcServerState = () => ({ ...state });

/** Test seam. Nothing in the service calls this. */
export const resetGrpcBindState = () => {
  state.bound = false;
  state.port = null;
  state.address = null;
  state.error = null;
  state.changedAt = null;
};

export default { recordGrpcBind, grpcServerState, resetGrpcBindState };
