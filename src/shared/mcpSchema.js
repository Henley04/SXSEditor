'use strict';
/**
 * MCP automation — single source of truth for the method surface.
 *
 * Everything downstream is generated from this table: request validation in
 * the bridge, `GET /schema`, the stdio MCP server's tool list and
 * docs/MCP.md. Adding a method means adding one entry here plus the handler.
 *
 * Field notes
 *   target     'main'     handled inside the Electron main process
 *              'renderer' forwarded to the main window renderer
 *              'editor'   forwarded to the fragment-editor window
 *   long       may exceed the default timeout; can be submitted as a job
 *   requires   preconditions the bridge checks before dispatch
 *   params     JSON-Schema (draft-07 subset used by src/main/mcpValidate.js)
 *   aliases    legacy top-level param names -> canonical name
 */

const obj = (properties, required = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});

const str = (description) => ({ type: 'string', description });
const num = (description, extra = {}) => ({ type: 'number', description, ...extra });
const bool = (description) => ({ type: 'boolean', description });
const int = (description, extra = {}) => ({ type: 'integer', description, ...extra });

const NOTE = obj({
  pitch: int('MIDI note number 0-127', { minimum: 0, maximum: 127 }),
  start: num('Start position in beats', { minimum: 0 }),
  duration: num('Duration in beats', { exclusiveMinimum: 0 }),
  lyric: str('Lyric for this note'),
  id: str('Optional stable id; derived from content when omitted'),
}, ['pitch', 'start', 'duration']);

const FRAGMENT = {
  type: 'object',
  additionalProperties: true,
  properties: {
    id: str('Fragment id'),
    singerId: str('Owning singer id'),
    name: str('Display name'),
    startTime: num('Start position in beats', { minimum: 0 }),
    duration: num('Duration in beats', { exclusiveMinimum: 0 }),
    notes: { type: 'array', items: NOTE },
  },
  required: ['singerId'],
};

const PITCH_ANCHOR = obj({
  time: num('Time in beats', { minimum: 0 }),
  pitch: num('Absolute MIDI pitch (NOT an offset)'),
  strength: num('Anchor strength 0-100', { minimum: 0, maximum: 100 }),
  smoothness: num('Segment smoothness 0-100', { minimum: 0, maximum: 100 }),
}, ['time', 'pitch']);

const PROJECT_DOC = obj({
  project: obj({ bpm: num('Beats per minute', { minimum: 1 }), timeSignature: { type: 'array', items: { type: 'integer' }, minItems: 2, maxItems: 2 } }),
  singers: { type: 'array', items: { type: 'object', additionalProperties: true } },
  fragments: { type: 'array', items: FRAGMENT },
}, ['singers', 'fragments']);

const OPERATION = obj({
  op: {
    type: 'string',
    enum: ['set_project', 'add_singer', 'update_singer', 'remove_singer', 'add_fragment',
      'update_fragment', 'remove_fragment', 'replace_notes', 'set_selection', 'clear_project'],
  },
  id: str('Target id for update_*/remove_* operations'),
  value: { type: 'object', additionalProperties: true },
  singerId: str('Singer id for set_selection'),
  fragmentId: str('Fragment id for set_selection / replace_notes'),
  notes: { type: 'array', items: NOTE },
}, ['op']);

const METHODS = {
  // ---------------------------------------------------------------- system
  'schema.get': {
    summary: 'Return this method table (same payload as GET /schema).',
    target: 'main', params: obj({}),
  },
  'capabilities': {
    summary: 'Method list plus runtime features and preconditions.',
    target: 'main', params: obj({}),
  },
  'session.grantRoot': {
    summary: 'Grant the automation session read/write access to a directory tree.',
    description: 'The directory is validated (no system/sensitive/hidden paths) and added to the same in-memory allow-list the file dialogs use. Grants live until the app exits or session.revokeRoots is called.',
    target: 'main', mutates: true,
    params: obj({ path: str('Absolute directory path') }, ['path']),
  },
  'session.roots': {
    summary: 'List directories granted in this session.',
    target: 'main', params: obj({}),
  },
  'session.revokeRoots': {
    summary: 'Revoke session directory grants (all when path is omitted).',
    target: 'main', mutates: true,
    params: obj({ path: str('Directory to revoke') }),
  },

  // -------------------------------------------------------------------- ui
  'ui.windows': {
    summary: 'List application windows with id, title, url and bounds.',
    target: 'main', params: obj({}),
  },
  'ui.resize': {
    summary: 'Resize a window (content size).',
    target: 'main', mutates: true,
    params: obj({
      window: str('Window id, url substring or title substring (default: main window)'),
      width: int('Content width in CSS px', { minimum: 200, maximum: 10000 }),
      height: int('Content height in CSS px', { minimum: 200, maximum: 10000 }),
    }, ['width', 'height']),
  },
  'ui.reload': {
    summary: 'Reload a window renderer.',
    target: 'main', mutates: true,
    params: obj({ window: str('Window selector (default: main window)') }),
  },
  'ui.locale': {
    summary: 'Switch the application language and reload every window.',
    target: 'main', mutates: true,
    params: obj({ locale: { type: 'string', enum: ['en', 'zh-CN'], description: 'Target locale' } }, ['locale']),
  },
  'ui.screenshot': {
    summary: 'Capture a window at a given CSS size and device scale.',
    description: 'Uses the DevTools protocol so the capture can be 2x even when the physical display is not. Without `path` the PNG is returned as base64.',
    target: 'main',
    params: obj({
      window: str('Window selector (default: main window)'),
      width: int('CSS width to emulate', { minimum: 100, maximum: 4000 }),
      height: int('CSS height to emulate', { minimum: 100, maximum: 4000 }),
      scale: num('Device scale factor (default 2)', { minimum: 1, maximum: 4 }),
      path: str('Save PNG here instead of returning base64'),
      keepSize: bool('Keep the window at its current size (default: resize, capture, restore)'),
    }),
  },

  // ------------------------------------------------------------------ jobs
  'jobs.list': { summary: 'List automation jobs (newest first).', target: 'main', params: obj({}) },
  'jobs.get': { summary: 'Get one job by id.', target: 'main', params: obj({ jobId: str('Job id') }, ['jobId']) },
  'jobs.cancel': { summary: 'Cancel a queued job; running jobs report that they cannot be stopped.', target: 'main', params: obj({ jobId: str('Job id') }, ['jobId']) },

  // --------------------------------------------------------------- project
  'project.get': {
    summary: 'Read the current project snapshot.',
    target: 'renderer',
    params: obj({
      includeNotes: bool('Include fragment notes (default true)'),
      noteOffset: int('Skip this many notes per fragment', { minimum: 0 }),
      noteLimit: int('Return at most this many notes per fragment', { minimum: 1 }),
      fields: { type: 'array', items: { type: 'string' }, description: 'Top-level fields to include: project, singers, fragments, selection, filePath, isDirty' },
    }),
  },
  'project.validate': {
    summary: 'Validate a project document without touching the open project.',
    target: 'renderer',
    params: obj({ project: PROJECT_DOC }, ['project']),
  },
  'project.apply': {
    summary: 'Apply a batch of operations atomically.',
    description: 'All operations are validated first. With atomic=true (default) a failure rolls the project back to the pre-call snapshot and returns the failing operation index.',
    target: 'renderer', mutates: true, params: obj({
      operations: { type: 'array', items: OPERATION, minItems: 1 },
      dryRun: bool('Validate and report what would change, without mutating'),
      atomic: bool('Roll back on failure (default true)'),
    }, ['operations']),
  },
  'project.replace': {
    summary: 'Replace the whole project document.',
    target: 'renderer', mutates: true, params: obj({
      project: PROJECT_DOC,
      dryRun: bool('Validate only'),
    }, ['project']),
  },
  'project.saveTo': {
    summary: 'Serialize the project to a .sxsproj file.',
    target: 'renderer', mutates: true, long: true,
    params: obj({
      path: str('Destination path'),
      embedSingerFiles: bool('Embed singer payloads inside the project'),
      embedAccompanimentAudio: bool('Embed accompaniment audio'),
    }, ['path']),
  },
  'project.loadFrom': {
    summary: 'Open a .sxsproj file into the editor.',
    target: 'renderer', mutates: true, long: true,
    params: obj({ path: str('Project file path') }, ['path']),
  },
  'project.save': { summary: 'Save to the current path (dialog fallback).', target: 'renderer', mutates: true, long: true, params: obj({}) },
  'project.saveAs': { summary: 'Save through the native dialog and return the chosen path.', target: 'renderer', mutates: true, long: true, params: obj({}) },
  'project.load': { summary: 'Open a project through the native dialog.', target: 'renderer', mutates: true, long: true, params: obj({}) },

  // ------------------------------------------------------------------ midi
  'midi.importFile': {
    summary: 'Import a .mid file as tracks and fragments.',
    target: 'main', mutates: true, long: true,
    params: obj({
      path: str('MIDI file path'),
      name: str('Track name override'),
      multiTrack: bool('Create one track per MIDI track (default true)'),
      createTracks: bool('Create new tracks instead of reusing singerId (default true)'),
      singerId: str('Existing singer to place the notes on'),
      startTime: num('Where the first fragment starts, in beats', { minimum: 0 }),
      applyProjectInfo: bool('Apply tempo/time signature from the MIDI file (default true)'),
    }, ['path']),
  },
  'midi.importParsed': {
    summary: 'Internal: bridge hands parsed MIDI to the renderer.',
    target: 'renderer', internal: true,
    params: obj({ tracks: { type: 'array', items: { type: 'object', additionalProperties: true } } }, ['tracks']),
  },
  'audio.extractMidi': {
    summary: 'Run F0/MIDI extraction on an audio file.',
    target: 'renderer', long: true,
    params: obj({
      path: str('Audio file path'),
      bpm: num('Tempo used for beat conversion', { minimum: 1 }),
      withPitch: bool('Also return the F0 curve (default true)'),
    }, ['path']),
  },

  // --------------------------------------------------------- media / singer
  'accompaniment.import': {
    summary: 'Add an accompaniment track from an audio file.',
    target: 'renderer', mutates: true, long: true,
    params: obj({
      path: str('Audio file path'),
      name: str('Track name'),
      startTime: num('Start offset in seconds', { minimum: 0 }),
      volume: num('Track volume 0-1', { minimum: 0, maximum: 1 }),
    }, ['path']),
  },
  'singer.import': {
    summary: 'Import a .sxssinger voice profile.',
    target: 'renderer', mutates: true, long: true,
    params: obj({ path: str('Singer file path') }, ['path']),
  },

  // --------------------------------------------------------------- history
  'history.undo': { summary: 'Undo the last project edit.', target: 'renderer', mutates: true, params: obj({}) },
  'history.redo': { summary: 'Redo the last undone edit.', target: 'renderer', mutates: true, params: obj({}) },

  // -------------------------------------------------------------- fragment
  'fragment.open': {
    summary: 'Open a fragment in the piano-roll editor window.',
    target: 'renderer', mutates: true,
    params: obj({ fragmentId: str('Fragment id') }, ['fragmentId']),
    aliases: { id: 'fragmentId' },
  },
  'fragment.getPitchCurve': {
    summary: 'Read a fragment pitch curve: auto config, manual anchors/brush/derived segments, and the manual coverage ranges.',
    description: 'Anchors store ABSOLUTE MIDI pitches. Manual content wins inside its coverage; the auto layer fills the rest.',
    target: 'renderer',
    params: obj({
      fragmentId: str('Fragment id'),
      includePoints: bool('Include every point of derived segments (default false: only id/range/pointCount)'),
    }, ['fragmentId']),
  },
  'fragment.setPitchCurve': {
    summary: 'Update a fragment pitch curve: auto params, on/off, preset, manual anchors, derived segments.',
    description: 'Omitted fields stay untouched. reset="manual" clears manual content (back to auto); reset="all" also disables auto.',
    target: 'renderer', mutates: true,
    params: obj({
      fragmentId: str('Fragment id'),
      auto: { type: 'object', additionalProperties: true, description: 'Partial auto config: { enabled, preset, params }' },
      anchorPoints: { type: 'array', items: PITCH_ANCHOR, description: 'Replace manual anchors (omit to keep)' },
      bakedSegments: { type: 'array', items: { type: 'object', additionalProperties: true }, description: 'Replace derived segments (omit to keep)' },
      reset: { type: 'string', enum: ['manual', 'all'], description: 'manual = clear manual layers; all = also disable auto' },
    }, ['fragmentId']),
  },
  'fragment.exportTo': {
    summary: 'Synthesize one fragment and write a WAV.',
    target: 'renderer', long: true, requires: ['models'],
    params: obj({
      fragmentId: str('Fragment id'),
      path: str('Destination WAV path'),
      options: { type: 'object', additionalProperties: true, description: 'Inference overrides (nSteps, cfg, sampler, sampleRate…)' },
    }, ['fragmentId', 'path']),
  },

  // -------------------------------------------------------------- editor
  'editor.getView': {
    summary: 'Read the editor view state (zoom, scroll, mode, selection).',
    target: 'editor',
    params: obj({}),
  },
  'editor.setView': {
    summary: 'Set zoom, scroll, edit mode and note selection in the editor.',
    target: 'editor', mutates: true,
    params: obj({
      zoomX: num('Horizontal zoom factor 0.25-8', { minimum: 0.25, maximum: 8 }),
      scrollBeats: num('Scroll so this beat is at the left edge', { minimum: 0 }),
      scrollY: num('Vertical scroll in px', { minimum: 0 }),
      mode: { type: 'string', enum: ['MIDI', 'Pitch'], description: 'Top edit mode' },
      paramLane: { type: 'string', enum: ['VOL', 'PAN', 'Phoneme', 'Timbre'], description: 'Bottom lane' },
      selectedNoteIds: { type: 'array', items: { type: 'string' }, description: 'Replace the note selection' },
    }),
  },

  // ------------------------------------------------------------ playback
  'playback.play': { summary: 'Synthesize and play the project.', target: 'renderer', long: true, requires: ['models'], params: obj({}) },
  'playback.pause': { summary: 'Pause playback.', target: 'renderer', params: obj({}) },
  'playback.stop': { summary: 'Stop playback.', target: 'renderer', params: obj({}) },
  'playback.seek': { summary: 'Seek to a position in seconds.', target: 'renderer', params: obj({ seconds: num('Target position', { minimum: 0 }) }, ['seconds']) },
  'playback.get': { summary: 'Playback state (position, duration, synthesizing).', target: 'renderer', params: obj({}) },

  // --------------------------------------------------------------- export
  'audio.export': { summary: 'Export via the GUI dialog.', target: 'renderer', mutates: true, long: true, requires: ['models'], params: obj({}) },
  'audio.exportTo': {
    summary: 'Synthesize the whole project and write a WAV.',
    target: 'renderer', long: true, requires: ['models'],
    params: obj({
      path: str('Destination WAV path'),
      options: { type: 'object', additionalProperties: true, description: 'sampleRate / numChannels / inference overrides' },
    }, ['path']),
  },
  'lrc.export': { summary: 'Export lyrics via the GUI dialog.', target: 'renderer', long: true, params: obj({}) },
  'lrc.exportTo': { summary: 'Write a .lrc file.', target: 'renderer', long: true, params: obj({ path: str('Destination path') }, ['path']) },

  // ------------------------------------------------------------- settings
  'settings.get': { summary: 'Read the settings object.', target: 'renderer', params: obj({}) },
  'settings.update': {
    summary: 'Patch settings and return the result.',
    target: 'renderer', mutates: true,
    params: obj({ settings: { type: 'object', additionalProperties: true, description: 'Settings patch' } }, ['settings']),
    aliases: { patch: 'settings' },
  },
  'ui.open': {
    summary: 'Open a secondary window (singer creator, market, model download…).',
    target: 'renderer', mutates: true,
    params: obj({
      target: { type: 'string', enum: ['singerCreator', 'singerMarket', 'modelDownload', 'resourceManager'] },
      precision: str('Model precision for modelDownload'),
    }, ['target']),
    aliases: { name: 'target' },
  },
};

const VERSION = '2.0';

function methodNames() { return Object.keys(METHODS); }

function getMethod(name) { return METHODS[name] || null; }

/** Public schema payload (drops internal methods). */
function schema() {
  const methods = {};
  for (const [name, def] of Object.entries(METHODS)) {
    if (def.internal) continue;
    methods[name] = {
      summary: def.summary,
      description: def.description || undefined,
      target: def.target,
      long: !!def.long,
      mutates: !!def.mutates,
      requires: def.requires || [],
      aliases: def.aliases || {},
      params: def.params,
      examples: def.examples || [],
    };
  }
  return { version: VERSION, methods };
}

module.exports = { METHODS, VERSION, schema, methodNames, getMethod, OBJECT: obj };
