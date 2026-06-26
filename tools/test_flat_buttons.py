import json, sys
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src"
THEME = json.loads((SRC / "themes" / "builtins" / "acg.theme.json").read_text(encoding="utf-8"))
root_css = "\n".join("  " + k + ": " + str(v) + ";" for k, v in THEME["tokens"].items())
root_css = ":root {\n" + root_css + "\n}"

css_links = "\n".join(
    '<link rel="stylesheet" href="' + str(SRC / f) + '">'
    for f in ["common.css", "index.css", "fragmentEditor.css", "settings.css",
              "audioPreprocess.css", "modelDownload.css", "resourceManager.css", "singerCreator.css"]
)

btns = [
    ("Default", ""), ("Primary", "btn-primary"), ("Success", "btn-success"),
    ("Danger", "btn-danger"), ("Small", "btn-small"), ("Small Primary", "btn-small btn-primary"),
    ("Small Danger", "btn-small btn-danger"), ("Param Active", "btn-param active"),
    ("Pitch Tool", "btn-pitch-tool"), ("Lane Tab", "param-lane-tab active"),
    ("Theme Action", "btn-theme-action"), ("Theme Danger", "btn-theme-action btn-theme-danger"),
    ("Editor Primary", "btn-theme-editor btn-theme-editor-primary"),
    ("Open Download", "btn-open-model-download"), ("Start", "btn-start"), ("Close", "btn-close"),
    ("Toolbar Primary", "btn-toolbar btn-primary"), ("Toolbar Success", "btn-toolbar btn-success"),
]
btn_html = "\n".join('<button class="' + c + '">' + t + "</button>" for t, c in btns)

html = (
    "<!DOCTYPE html><html><head><meta charset='utf-8'><style>\n"
    + root_css + "\n"
    "html,body{background:var(--bg-app);color:var(--fg-primary);font-family:sans-serif}\n"
    "#toolbar{display:flex;align-items:center;gap:6px;padding:8px 12px;flex-wrap:wrap;"
    "background:var(--bg-toolbar-start);border-bottom:1px solid var(--border-subtle)}\n"
    ".btn-theme-action.btn-theme-primary{background:var(--bg-button-primary);"
    "color:var(--fg-on-accent);border-color:var(--accent)}\n"
    "</style>\n" + css_links + "\n</head><body>\n"
    "<h2 style='padding:12px 16px;margin:0'>ACG Flat Button Verification</h2>\n"
    '<div id="toolbar">' + btn_html + "</div>\n</body></html>"
)

out_html = ROOT / "tools" / "_flat_button_harness.html"
out_html.write_text(html, encoding="utf-8")
print("HTML size:", out_html.stat().st_size)

shot = ROOT / "tools" / "_flat_button_harness.png"
failures = []
with sync_playwright() as p:
    br = p.chromium.launch(headless=True, channel="chrome")
    pg = br.new_page(viewport={"width": 1200, "height": 700})
    pg.goto(out_html.as_uri())
    pg.wait_for_load_state("networkidle")
    els = pg.locator("#toolbar button").all()
    print("Buttons:", len(els))
    for i, b in enumerate(els):
        t = (b.text_content() or "").strip()
        bs = b.evaluate("el => getComputedStyle(el).boxShadow")
        bi = b.evaluate("el => getComputedStyle(el).backgroundImage")
        ts = b.evaluate("el => getComputedStyle(el).textShadow")
        tr = b.evaluate("el => getComputedStyle(el).transform")
        lab = "#" + str(i) + " '" + t + "'"
        ok = True
        if bs != "none":
            failures.append(lab + " box-shadow=" + bs); ok = False
        if bi != "none":
            failures.append(lab + " bg-image=" + bi); ok = False
        if ts != "none":
            failures.append(lab + " text-shadow=" + ts); ok = False
        if tr != "none":
            failures.append(lab + " transform=" + tr); ok = False
        print(("  OK   " if ok else "  FAIL ") + lab)
    pg.screenshot(path=str(shot), full_page=True)
    br.close()

print("Screenshot:", shot)
if failures:
    print(str(len(failures)) + " FAILURE(S):")
    for f in failures:
        print("  - " + f)
    sys.exit(1)
print("ALL FLAT: no box-shadow, solid bg, no text-shadow, no transform.")
