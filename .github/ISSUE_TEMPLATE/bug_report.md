---
name: Bug report
about: Create a report to help us improve
title: "[BUG]"
labels: bug
assignees: Henley04

---

**Describe the bug**
A clear and concise description of what the bug is.

**To Reproduce**
Steps to reproduce the behavior:
1. Go to '...'
2. Click on '....'
3. Scroll down to '....'
4. See error

**Expected behavior**
A clear and concise description of what you expected to happen.

**Screenshots**
If applicable, add screenshots to help explain your problem.

**Desktop (please complete the following information):**
 - Version [e.g. 22]
 - Hardware(optional): [e.g. NVIDIA RTX 5060 laptop]

**Crash logs and dump files (IMPORTANT — please attach)**
SXSEditor automatically records crash logs and minidumps. If the app crashed, froze, or you saw an unexpected error, please attach these files — they make diagnosis much faster.

How to find them:
- In the app: open the **Help** menu → **Open Logs Folder** / **Open Crash Dumps Folder**.
- Manually: navigate to `%APPDATA%\SXSEditor\` (Windows).
  - `logs\` — session log files (`sxseditor-YYYYMMDD-HHmmss-<pid>.log`). The newest file matches the session that crashed. Only the 10 most recent are kept.
  - `dumps\` — crash minidumps (`*.dmp`). Only the 3 most recent are kept. The log file from the crashing session lists the dump file name and path near the FATAL line.

Please attach:
1. The most recent `.dmp` file(s) from `dumps\`
2. The `.log` file from the crashing session

If you did not encounter a crash, you can leave this blank.

**Additional context**
Add any other context about the problem here.

