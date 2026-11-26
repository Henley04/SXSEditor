const { expect } = require('chai');

const bridge = require('../src/main/mcpBridge');

/**
 * 模型域错误码 → MCP 错误码的映射。
 *
 * 这条映射在真实调用链上出过一次事故：`model.invoke` 解析不到端点时直接把
 * `NEED_ENDPOINT` 塞进 `McpError`，而 `McpError` 只认自己那张表，不认识的一律
 * 塌成 `INTERNAL/500`。结果是"I 你没绑端点"和"II 宿主内部炸了"在客户端看来
 * 完全一样，重试策略必然做错。
 *
 * 所以这里锁两件事：分类正确、原始码不丢。
 */
describe('mcpBridge — model error mapping', function () {
  const { modelErrorToMcp } = bridge._internal;

  it('maps NEED_ENDPOINT to PRECONDITION_FAILED and keeps the model code', function () {
    const err = modelErrorToMcp({ code: 'NEED_ENDPOINT', message: 'task=chat 没有默认端点' });
    expect(err.code).to.equal('PRECONDITION_FAILED');
    expect(err.status).to.equal(422);
    expect(err.details.modelCode).to.equal('NEED_ENDPOINT');
  });

  it('maps consent/denial to FORBIDDEN, not INTERNAL', function () {
    for (const code of ['PERMISSION_DENIED', 'CONSENT_REQUIRED', 'CONSENT_TIMEOUT']) {
      const err = modelErrorToMcp({ code });
      expect(err.code, code).to.equal('FORBIDDEN');
      expect(err.details.modelCode).to.equal(code);
    }
  });

  it('keeps backpressure distinct from a real failure', function () {
    const err = modelErrorToMcp({ code: 'BACKPRESSURE_OVERFLOW' });
    expect(err.code).to.equal('RATE_LIMITED');
    expect(err.details.retryable).to.equal(false);
  });

  it('carries the retryable flag through for upstream failures', function () {
    const err = modelErrorToMcp({ code: 'UPSTREAM_ERROR', message: '502', retryable: true });
    expect(err.code).to.equal('INTERNAL');
    expect(err.details.retryable).to.equal(true);
  });

  it('falls back to INTERNAL only for codes outside the model vocabulary', function () {
    expect(modelErrorToMcp({ code: 'SOMETHING_NEW' }).code).to.equal('INTERNAL');
    expect(modelErrorToMcp({ code: 'SOMETHING_NEW' }).details.modelCode).to.equal('SOMETHING_NEW');
  });

  it('an unmapped model code never leaks into the MCP code field', function () {
    const err = modelErrorToMcp({ code: 'NEED_ENDPOINT' });
    expect(err.code).to.not.equal('NEED_ENDPOINT');
    expect(err.code).to.match(/^[A-Z_]+$/);
  });
});
