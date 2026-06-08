export type MemStackErrorCode =
  | "STORAGE_ERROR"
  | "EMBEDDING_ERROR"
  | "LLM_ERROR"
  | "VALIDATION_ERROR"
  | "NOT_FOUND"
  | "CONFIG_ERROR";

export class MemStackError extends Error {
  code: MemStackErrorCode;
  retryable: boolean;
  details?: Record<string, unknown>;

  constructor(
    code: MemStackErrorCode,
    message: string,
    options: { retryable?: boolean; details?: Record<string, unknown> } = {}
  ) {
    super(message);
    this.name = "MemStackError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }
}

export function notFound(entity: string, id: string): MemStackError {
  return new MemStackError("NOT_FOUND", `${entity} not found: ${id}`, {
    retryable: false,
    details: { entity, id },
  });
}

export function validationError(message: string, details?: Record<string, unknown>): MemStackError {
  return new MemStackError("VALIDATION_ERROR", message, { details });
}

export function storageError(message: string, cause?: unknown): MemStackError {
  return new MemStackError("STORAGE_ERROR", message, {
    retryable: true,
    details: { cause: cause instanceof Error ? cause.message : String(cause) },
  });
}

export function configError(message: string): MemStackError {
  return new MemStackError("CONFIG_ERROR", message, { retryable: false });
}
