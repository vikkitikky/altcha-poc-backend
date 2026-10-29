import { performance } from 'node:perf_hooks';
import { MockCaptchaMs, MsRejection, type MsContext, type ResultMode } from './ms-captcha.js';

/** In-process model of Business MS -> internal CAPTCHA MS. It is not a network hop. */
export class MockBusinessMs {
  constructor(private captcha: MockCaptchaMs) {}
  async submit(mode: ResultMode, candidate: unknown, expected: MsContext, session: string, deny = false) {
    const started = performance.now();
    const decision = await this.captcha.authorize(mode, candidate, expected, session);
    // CAPTCHA approval and business approval are separate decisions. This refusal consumes the result.
    if (deny) return { success: false, code: 'BUSINESS_RULE_REJECTED', captcha: decision,
      internal_call: { transport: 'in-process', duration_ms: performance.now() - started } };
    return { success: true, message: 'Mock Business MS выполнил операцию', captcha: decision,
      internal_call: { transport: 'in-process', duration_ms: performance.now() - started } };
  }
}
export { MsRejection };
