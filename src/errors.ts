export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}
export class StorageUnavailable extends ApiError {
  constructor() { super(503, 'STORAGE_UNAVAILABLE'); }
}
