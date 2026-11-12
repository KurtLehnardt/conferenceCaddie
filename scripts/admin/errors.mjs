// Error classes of the caddie-admin CLI. Each carries the exit code the process ends with and the
// short code printed in `--json` error objects. A thrown plain Error is treated as an AdminError.

export class AdminError extends Error {
  exitCode = 1;
  code = 'failed';
  constructor(message) {
    super(message);
    this.name = new.target.name;
  }
}

// Bad command line, bad target syntax, or a missing or malformed config file (exit 2).
export class UsageError extends AdminError {
  exitCode = 2;
  code = 'usage';
}

// A destructive command was not confirmed, or the confirmation did not match (exit 3).
export class ConfirmError extends AdminError {
  exitCode = 3;
  code = 'confirm';
}

// The target does not exist on the backend (exit 4).
export class NotFoundError extends AdminError {
  exitCode = 4;
  code = 'not_found';
}

// The backend's tier cannot serve the command (exit 5).
export class UnsupportedError extends AdminError {
  exitCode = 5;
  code = 'unsupported';
}
