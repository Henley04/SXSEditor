'use strict';
/**
 * Background job registry for long-running automation calls.
 *
 * A job is just a promise plus its observable state: the bridge answers
 * `202 {jobId}` immediately and the client polls `jobs.get` (or listens on
 * /events). Nothing survives an app restart — jobs are session state.
 */

const crypto = require('node:crypto');

const MAX_JOBS = 100;
const TTL_MS = 30 * 60 * 1000;

const jobs = new Map();

function prune() {
  const now = Date.now();
  const all = [...jobs.values()].sort((a, b) => b.createdAt - a.createdAt);
  all.forEach((job, i) => {
    const active = job.status === 'running' || job.status === 'queued';
    const expired = !active && now - job.createdAt > TTL_MS;
    // Evicting an active job would make finish() return null while the work is
    // still in flight, producing an unhandled rejection in the bridge.
    if (expired || (i >= MAX_JOBS && !active)) jobs.delete(job.id);
  });
}

function create(method) {
  prune();
  const job = {
    id: `job_${crypto.randomBytes(6).toString('hex')}`,
    method,
    status: 'queued',
    createdAt: Date.now(),
    startedAt: null,
    endedAt: null,
    cancelRequested: false,
    result: undefined,
    error: undefined,
  };
  jobs.set(job.id, job);
  return job;
}

function start(id) {
  const job = jobs.get(id);
  if (!job) return null;
  job.status = 'running';
  job.startedAt = Date.now();
  return job;
}

function finish(id, { result, error }) {
  const job = jobs.get(id);
  if (!job) return null;
  job.endedAt = Date.now();
  if (error) {
    job.status = job.cancelRequested ? 'cancelled' : 'failed';
    job.error = error;
  } else if (job.cancelRequested) {
    // The caller cancelled while the work was in flight: report it as cancelled
    // and drop the payload instead of handing back a result nobody wants.
    job.status = 'cancelled';
  } else {
    job.status = 'completed';
    job.result = result;
  }
  return job;
}

function get(id) {
  const job = jobs.get(id);
  return job ? serialize(job) : null;
}

function list() {
  return [...jobs.values()]
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(serialize);
}

function cancel(id) {
  const job = jobs.get(id);
  if (!job) return null;
  if (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') {
    return { jobId: id, cancelled: false, status: job.status, reason: 'already finished' };
  }
  job.cancelRequested = true;
  if (job.status === 'queued') {
    job.status = 'cancelled';
    job.endedAt = Date.now();
    return { jobId: id, cancelled: true, status: job.status };
  }
  return { jobId: id, cancelled: false, status: job.status, reason: 'running jobs cannot be interrupted; the result will be discarded' };
}

function serialize(job) {
  const out = {
    jobId: job.id,
    method: job.method,
    status: job.status,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    endedAt: job.endedAt,
    elapsedMs: (job.endedAt || Date.now()) - (job.startedAt || job.createdAt),
  };
  if (job.result !== undefined) out.result = job.result;
  if (job.error !== undefined) out.error = job.error;
  return out;
}

module.exports = { create, start, finish, get, list, cancel, serialize };
