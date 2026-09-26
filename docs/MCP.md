# SXSEditor MCP

Start SXSEditor, then configure the client to run `node scripts/sxseditor-mcp.js` over stdio. The application bridge listens only on `127.0.0.1`, uses a random 256-bit token, limits requests to 32 MiB, and removes its endpoint file on exit.

Read `sxseditor://schema`, `sxseditor://project`, and `sxseditor://capabilities`. The MCP surface supports complete project JSON editing, singer/accompaniment tracks, fragment placement, MIDI notes and lyrics, envelopes, pitch curves, Standard MIDI File import, audio-to-MIDI/F0 extraction, singer import, playback and status, undo/redo, project files, whole-project and single-fragment WAV export, LRC lyrics export, settings, fragment editor and application windows.

```json
{"mcpServers":{"sxseditor":{"command":"node","args":["D:/path/SXSEditor/scripts/sxseditor-mcp.js"]}}}
```
