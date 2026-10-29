export type ApiErrorCode = 'auth' | 'rate_limit' | 'network' | 'data' | 'timeout' | 'query_id'

export class XApiError extends Error {
  code: ApiErrorCode
  /** rate_limit 时: 可重试的时间戳 (ms) */
  resetAt?: number
  status?: number
  constructor(code: ApiErrorCode, message: string, opts: { resetAt?: number; status?: number } = {}) {
    super(message)
    this.name = 'XApiError'
    this.code = code
    this.resetAt = opts.resetAt
    this.status = opts.status
  }
}
