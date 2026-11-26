const { expect } = require('chai');
const jobs = require('../src/main/mcpJobs');

describe('MCP job registry', function () {
  it('creates a queued job and moves it to completed', function () {
    const job = jobs.create('audio.exportTo');
    expect(job.status).to.equal('queued');
    jobs.start(job.id);
    expect(jobs.get(job.id).status).to.equal('running');
    jobs.finish(job.id, { result: { path: 'x.wav' } });
    const done = jobs.get(job.id);
    expect(done.status).to.equal('completed');
    expect(done.result).to.deep.equal({ path: 'x.wav' });
    expect(done.endedAt).to.be.a('number');
  });

  it('records failures with the structured error payload', function () {
    const job = jobs.create('fragment.exportTo');
    jobs.start(job.id);
    jobs.finish(job.id, { error: { code: 'PRECONDITION_FAILED', message: 'no models' } });
    const done = jobs.get(job.id);
    expect(done.status).to.equal('failed');
    expect(done.error.code).to.equal('PRECONDITION_FAILED');
  });

  it('cancelling a finished job reports that it already finished', function () {
    const job = jobs.create('lrc.exportTo');
    jobs.start(job.id);
    jobs.finish(job.id, { result: {} });
    const r = jobs.cancel(job.id);
    expect(r.cancelled).to.equal(false);
    expect(r.status).to.equal('completed');
  });

  it('a cancel request during execution wins and drops the result', function () {
    const job = jobs.create('audio.export');
    jobs.start(job.id);
    const r = jobs.cancel(job.id);
    expect(r.cancelled).to.equal(false);
    expect(r.reason).to.contain('cannot be interrupted');
    jobs.finish(job.id, { result: { huge: 'payload' } });
    const done = jobs.get(job.id);
    expect(done.status).to.equal('cancelled');
    expect(done.result).to.equal(undefined);
  });

  it('never prunes running jobs, even when the cap is exceeded', function () {
    const running = [];
    for (let i = 0; i < 120; i++) {
      const j = jobs.create('playback.play');
      jobs.start(j.id);
      running.push(j.id);
    }
    const alive = running.filter((id) => jobs.get(id));
    expect(alive.length).to.equal(running.length);
    for (const id of running) jobs.finish(id, { result: {} });
  });

  it('returns null for unknown ids', function () {
    expect(jobs.get('job_nope')).to.equal(null);
    expect(jobs.cancel('job_nope')).to.equal(null);
  });
});
