# Automation API (MCP)

Schema version **2.0** — generated from `src/shared/mcpSchema.js` by `npm run mcp:docs`. Do not edit by hand.

SXSEditor exposes a loopback HTTP bridge so agents and scripts can drive the editor.
The stdio MCP server (`npm run mcp`) wraps the same API; both share one schema.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Liveness, app + schema version (Bearer token still required) |
| GET | `/schema` | Method table with JSON Schema |
| GET | `/events` | Server-sent events (`?token=` allowed, EventSource cannot set headers) |
| GET | `/jobs`, `/jobs/:id` | Background job status |
| POST | `/automation` | `{method, params, requestId?, async?}` |

Discovery file: `<userData>/mcp-endpoint.json` (mode `0600`) with `port`, `token`,
`tokens[]` (named tokens from `mcp-tokens.json`), `version`, `schemaVersion`, `urls`.

## Calling

```bash
EP=$(node -p "require(process.env.HOME+'/.config/SXSEditor/mcp-endpoint.json').port")
TOKEN=$(node -p "require(process.env.HOME+'/.config/SXSEditor/mcp-endpoint.json').token")
curl -s localhost:$EP/automation -H "Authorization: Bearer $TOKEN" \
  -H "content-type: application/json" \
  -d '{"method":"project.get","params":{"includeNotes":false}}'
```

Every response is `{ok, result, warnings?, requestId?}` or
`{ok:false, error:{code, message, field?, hint?, details?}}`.

## Errors

| Code | HTTP | Meaning |
|---|---|---|
| `VALIDATION_ERROR` | 400 | — |
| `UNAUTHORIZED` | 401 | — |
| `FORBIDDEN` | 403 | — |
| `NOT_FOUND` | 404 | — |
| `CONFLICT` | 409 | — |
| `PRECONDITION_FAILED` | 422 | — |
| `RATE_LIMITED` | 429 | — |
| `TIMEOUT` | 504 | — |
| `CANCELLED` | 409 | — |
| `INTERNAL` | 500 | — |

## Events

`/events` streams `event: <type>` frames. Current types: `bridge.started`,
`project.changed`, `project.saved`, `fragment.opened`, `playback.state`,
`ui.opened`, `job.started`, `job.completed`, `job.failed`.

## Jobs

Add `"async": true` to `POST /automation` for long methods (export, synthesis, MIDI extraction).
The call returns `202 {jobId, poll}`; poll `GET /jobs/<id>` for `status`
(`queued` → `running` → `completed` / `failed` / `cancelled`) plus `result` or `error`.

## Methods

### `schema.get`

Return this method table (same payload as GET /schema).

_target: `main`_

_No parameters._

```json
{
  "method": "schema.get",
  "params": {}
}
```

### `capabilities`

Method list plus runtime features and preconditions.

_target: `main`_

_No parameters._

```json
{
  "method": "capabilities",
  "params": {}
}
```

### `session.grantRoot`

Grant the automation session read/write access to a directory tree.

The directory is validated (no system/sensitive/hidden paths) and added to the same in-memory allow-list the file dialogs use. Grants live until the app exits or session.revokeRoots is called.

_target: `main` · mutates project_

| Parameter | Type / notes |
|---|---|
| `path` | string · required · Absolute directory path |

```json
{
  "method": "session.grantRoot",
  "params": {
    "path": "${path}"
  }
}
```

### `session.roots`

List directories granted in this session.

_target: `main`_

_No parameters._

```json
{
  "method": "session.roots",
  "params": {}
}
```

### `session.revokeRoots`

Revoke session directory grants (all when path is omitted).

_target: `main` · mutates project_

| Parameter | Type / notes |
|---|---|
| `path` | string · optional · Directory to revoke |

```json
{
  "method": "session.revokeRoots",
  "params": {
    "path": "${path}"
  }
}
```

### `ui.windows`

List application windows with id, title, url and bounds.

_target: `main`_

_No parameters._

```json
{
  "method": "ui.windows",
  "params": {}
}
```

### `ui.resize`

Resize a window (content size).

_target: `main` · mutates project_

| Parameter | Type / notes |
|---|---|
| `window` | string · optional · Window id, url substring or title substring (default: main window) |
| `width` | integer · required · Content width in CSS px · range 200..10000 |
| `height` | integer · required · Content height in CSS px · range 200..10000 |

```json
{
  "method": "ui.resize",
  "params": {
    "window": "${window}",
    "width": 1,
    "height": 1
  }
}
```

### `ui.reload`

Reload a window renderer.

_target: `main` · mutates project_

| Parameter | Type / notes |
|---|---|
| `window` | string · optional · Window selector (default: main window) |

```json
{
  "method": "ui.reload",
  "params": {
    "window": "${window}"
  }
}
```

### `ui.locale`

Switch the application language and reload every window.

_target: `main` · mutates project_

| Parameter | Type / notes |
|---|---|
| `locale` | `en` | `zh-CN` · required · Target locale |

```json
{
  "method": "ui.locale",
  "params": {
    "locale": "en"
  }
}
```

### `ui.screenshot`

Capture a window at a given CSS size and device scale.

Uses the DevTools protocol so the capture can be 2x even when the physical display is not. Without `path` the PNG is returned as base64.

_target: `main`_

| Parameter | Type / notes |
|---|---|
| `window` | string · optional · Window selector (default: main window) |
| `width` | integer · optional · CSS width to emulate · range 100..4000 |
| `height` | integer · optional · CSS height to emulate · range 100..4000 |
| `scale` | number · optional · Device scale factor (default 2) · range 1..4 |
| `path` | string · optional · Save PNG here instead of returning base64 |
| `keepSize` | boolean · optional · Keep the window at its current size (default: resize, capture, restore) |

```json
{
  "method": "ui.screenshot",
  "params": {
    "window": "${window}",
    "width": 1,
    "height": 1,
    "scale": 1,
    "path": "${path}",
    "keepSize": true
  }
}
```

### `jobs.list`

List automation jobs (newest first).

_target: `main`_

_No parameters._

```json
{
  "method": "jobs.list",
  "params": {}
}
```

### `jobs.get`

Get one job by id.

_target: `main`_

| Parameter | Type / notes |
|---|---|
| `jobId` | string · required · Job id |

```json
{
  "method": "jobs.get",
  "params": {
    "jobId": "${jobId}"
  }
}
```

### `jobs.cancel`

Cancel a queued job; running jobs report that they cannot be stopped.

_target: `main`_

| Parameter | Type / notes |
|---|---|
| `jobId` | string · required · Job id |

```json
{
  "method": "jobs.cancel",
  "params": {
    "jobId": "${jobId}"
  }
}
```

### `project.get`

Read the current project snapshot.

_target: `renderer`_

| Parameter | Type / notes |
|---|---|
| `includeNotes` | boolean · optional · Include fragment notes (default true) |
| `noteOffset` | integer · optional · Skip this many notes per fragment · range 0..∞ |
| `noteLimit` | integer · optional · Return at most this many notes per fragment · range 1..∞ |
| `fields` | string[] · optional · Top-level fields to include: project, singers, fragments, selection, filePath, isDirty |

```json
{
  "method": "project.get",
  "params": {
    "includeNotes": true,
    "noteOffset": 1,
    "noteLimit": 1,
    "fields": []
  }
}
```

### `project.validate`

Validate a project document without touching the open project.

_target: `renderer`_

| Parameter | Type / notes |
|---|---|
| `project` | object · required |

```json
{
  "method": "project.validate",
  "params": {
    "project": {}
  }
}
```

### `project.apply`

Apply a batch of operations atomically.

All operations are validated first. With atomic=true (default) a failure rolls the project back to the pre-call snapshot and returns the failing operation index.

_target: `renderer` · mutates project_

| Parameter | Type / notes |
|---|---|
| `operations` | object[] · required |
| `dryRun` | boolean · optional · Validate and report what would change, without mutating |
| `atomic` | boolean · optional · Roll back on failure (default true) |

```json
{
  "method": "project.apply",
  "params": {
    "operations": [],
    "dryRun": true,
    "atomic": true
  }
}
```

### `project.replace`

Replace the whole project document.

_target: `renderer` · mutates project_

| Parameter | Type / notes |
|---|---|
| `project` | object · required |
| `dryRun` | boolean · optional · Validate only |

```json
{
  "method": "project.replace",
  "params": {
    "project": {},
    "dryRun": true
  }
}
```

### `project.saveTo`

Serialize the project to a .sxsproj file.

_target: `renderer` · mutates project · long-running (job-able)_

| Parameter | Type / notes |
|---|---|
| `path` | string · required · Destination path |
| `embedSingerFiles` | boolean · optional · Embed singer payloads inside the project |
| `embedAccompanimentAudio` | boolean · optional · Embed accompaniment audio |

```json
{
  "method": "project.saveTo",
  "params": {
    "path": "${path}",
    "embedSingerFiles": true,
    "embedAccompanimentAudio": true
  }
}
```

### `project.loadFrom`

Open a .sxsproj file into the editor.

_target: `renderer` · mutates project · long-running (job-able)_

| Parameter | Type / notes |
|---|---|
| `path` | string · required · Project file path |

```json
{
  "method": "project.loadFrom",
  "params": {
    "path": "${path}"
  }
}
```

### `project.save`

Save to the current path (dialog fallback).

_target: `renderer` · mutates project · long-running (job-able)_

_No parameters._

```json
{
  "method": "project.save",
  "params": {}
}
```

### `project.saveAs`

Save through the native dialog and return the chosen path.

_target: `renderer` · mutates project · long-running (job-able)_

_No parameters._

```json
{
  "method": "project.saveAs",
  "params": {}
}
```

### `project.load`

Open a project through the native dialog.

_target: `renderer` · mutates project · long-running (job-able)_

_No parameters._

```json
{
  "method": "project.load",
  "params": {}
}
```

### `midi.importFile`

Import a .mid file as tracks and fragments.

_target: `main` · mutates project · long-running (job-able)_

| Parameter | Type / notes |
|---|---|
| `path` | string · required · MIDI file path |
| `name` | string · optional · Track name override |
| `multiTrack` | boolean · optional · Create one track per MIDI track (default true) |
| `createTracks` | boolean · optional · Create new tracks instead of reusing singerId (default true) |
| `singerId` | string · optional · Existing singer to place the notes on |
| `startTime` | number · optional · Where the first fragment starts, in beats · range 0..∞ |
| `applyProjectInfo` | boolean · optional · Apply tempo/time signature from the MIDI file (default true) |

```json
{
  "method": "midi.importFile",
  "params": {
    "path": "${path}",
    "name": "${name}",
    "multiTrack": true,
    "createTracks": true,
    "singerId": "${singerId}",
    "startTime": 1,
    "applyProjectInfo": true
  }
}
```

### `audio.extractMidi`

Run F0/MIDI extraction on an audio file.

_target: `renderer` · long-running (job-able)_

| Parameter | Type / notes |
|---|---|
| `path` | string · required · Audio file path |
| `bpm` | number · optional · Tempo used for beat conversion · range 1..∞ |
| `withPitch` | boolean · optional · Also return the F0 curve (default true) |

```json
{
  "method": "audio.extractMidi",
  "params": {
    "path": "${path}",
    "bpm": 1,
    "withPitch": true
  }
}
```

### `accompaniment.import`

Add an accompaniment track from an audio file.

_target: `renderer` · mutates project · long-running (job-able)_

| Parameter | Type / notes |
|---|---|
| `path` | string · required · Audio file path |
| `name` | string · optional · Track name |
| `startTime` | number · optional · Start offset in seconds · range 0..∞ |
| `volume` | number · optional · Track volume 0-1 · range 0..1 |

```json
{
  "method": "accompaniment.import",
  "params": {
    "path": "${path}",
    "name": "${name}",
    "startTime": 1,
    "volume": 1
  }
}
```

### `singer.import`

Import a .sxssinger voice profile.

_target: `renderer` · mutates project · long-running (job-able)_

| Parameter | Type / notes |
|---|---|
| `path` | string · required · Singer file path |

```json
{
  "method": "singer.import",
  "params": {
    "path": "${path}"
  }
}
```

### `history.undo`

Undo the last project edit.

_target: `renderer` · mutates project_

_No parameters._

```json
{
  "method": "history.undo",
  "params": {}
}
```

### `history.redo`

Redo the last undone edit.

_target: `renderer` · mutates project_

_No parameters._

```json
{
  "method": "history.redo",
  "params": {}
}
```

### `fragment.open`

Open a fragment in the piano-roll editor window.

_target: `renderer` · mutates project_

| Parameter | Type / notes |
|---|---|
| `fragmentId` | string · required · Fragment id |

Legacy aliases: `id` → `fragmentId` (accepted with a deprecation warning).

```json
{
  "method": "fragment.open",
  "params": {
    "fragmentId": "${fragmentId}"
  }
}
```

### `fragment.exportTo`

Synthesize one fragment and write a WAV.

_target: `renderer` · long-running (job-able) · requires: `models`_

| Parameter | Type / notes |
|---|---|
| `fragmentId` | string · required · Fragment id |
| `path` | string · required · Destination WAV path |
| `options` | object · optional · Inference overrides (nSteps, cfg, sampler, sampleRate…) |

```json
{
  "method": "fragment.exportTo",
  "params": {
    "fragmentId": "${fragmentId}",
    "path": "${path}",
    "options": {}
  }
}
```

### `editor.getView`

Read the editor view state (zoom, scroll, mode, selection).

_target: `editor`_

_No parameters._

```json
{
  "method": "editor.getView",
  "params": {}
}
```

### `editor.setView`

Set zoom, scroll, edit mode and note selection in the editor.

_target: `editor` · mutates project_

| Parameter | Type / notes |
|---|---|
| `zoomX` | number · optional · Horizontal zoom factor 0.25-8 · range 0.25..8 |
| `scrollBeats` | number · optional · Scroll so this beat is at the left edge · range 0..∞ |
| `scrollY` | number · optional · Vertical scroll in px · range 0..∞ |
| `mode` | `MIDI` | `Pitch` · optional · Top edit mode |
| `paramLane` | `VOL` | `PAN` | `Phoneme` | `Timbre` · optional · Bottom lane |
| `selectedNoteIds` | string[] · optional · Replace the note selection |

```json
{
  "method": "editor.setView",
  "params": {
    "zoomX": 1,
    "scrollBeats": 1,
    "scrollY": 1,
    "mode": "MIDI",
    "paramLane": "VOL",
    "selectedNoteIds": []
  }
}
```

### `playback.play`

Synthesize and play the project.

_target: `renderer` · long-running (job-able) · requires: `models`_

_No parameters._

```json
{
  "method": "playback.play",
  "params": {}
}
```

### `playback.pause`

Pause playback.

_target: `renderer`_

_No parameters._

```json
{
  "method": "playback.pause",
  "params": {}
}
```

### `playback.stop`

Stop playback.

_target: `renderer`_

_No parameters._

```json
{
  "method": "playback.stop",
  "params": {}
}
```

### `playback.seek`

Seek to a position in seconds.

_target: `renderer`_

| Parameter | Type / notes |
|---|---|
| `seconds` | number · required · Target position · range 0..∞ |

```json
{
  "method": "playback.seek",
  "params": {
    "seconds": 1
  }
}
```

### `playback.get`

Playback state (position, duration, synthesizing).

_target: `renderer`_

_No parameters._

```json
{
  "method": "playback.get",
  "params": {}
}
```

### `audio.export`

Export via the GUI dialog.

_target: `renderer` · mutates project · long-running (job-able) · requires: `models`_

_No parameters._

```json
{
  "method": "audio.export",
  "params": {}
}
```

### `audio.exportTo`

Synthesize the whole project and write a WAV.

_target: `renderer` · long-running (job-able) · requires: `models`_

| Parameter | Type / notes |
|---|---|
| `path` | string · required · Destination WAV path |
| `options` | object · optional · sampleRate / numChannels / inference overrides |

```json
{
  "method": "audio.exportTo",
  "params": {
    "path": "${path}",
    "options": {}
  }
}
```

### `lrc.export`

Export lyrics via the GUI dialog.

_target: `renderer` · long-running (job-able)_

_No parameters._

```json
{
  "method": "lrc.export",
  "params": {}
}
```

### `lrc.exportTo`

Write a .lrc file.

_target: `renderer` · long-running (job-able)_

| Parameter | Type / notes |
|---|---|
| `path` | string · required · Destination path |

```json
{
  "method": "lrc.exportTo",
  "params": {
    "path": "${path}"
  }
}
```

### `settings.get`

Read the settings object.

_target: `renderer`_

_No parameters._

```json
{
  "method": "settings.get",
  "params": {}
}
```

### `settings.update`

Patch settings and return the result.

_target: `renderer` · mutates project_

| Parameter | Type / notes |
|---|---|
| `settings` | object · required · Settings patch |

Legacy aliases: `patch` → `settings` (accepted with a deprecation warning).

```json
{
  "method": "settings.update",
  "params": {
    "settings": {}
  }
}
```

### `ui.open`

Open a secondary window (singer creator, market, model download…).

_target: `renderer` · mutates project_

| Parameter | Type / notes |
|---|---|
| `target` | `singerCreator` | `singerMarket` | `modelDownload` | `resourceManager` · required |
| `precision` | string · optional · Model precision for modelDownload |

Legacy aliases: `name` → `target` (accepted with a deprecation warning).

```json
{
  "method": "ui.open",
  "params": {
    "target": "singerCreator",
    "precision": "${precision}"
  }
}
```

## Notes

- Parameters are flat: the document for `project.replace` goes directly under `params.project`.
- File paths must be inside a directory granted with `session.grantRoot` (or one of the
  app's default save roots). Grants are session-scoped and disappear on exit.
  The renderer additionally self-authorizes individually whitelisted media/project files
  (`.wav`, `.sxssinger`, `.sxsproj`, `.mid`, `.lrc`) through the same path rules as the dialogs.
- `project.apply` validates every operation before mutating and rolls back on failure
  (`atomic: false` opts out). `dryRun: true` returns the plan without touching state.
- Note ids are derived from note content, so identical payloads produce identical ids.
