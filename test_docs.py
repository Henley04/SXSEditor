from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={'width': 1440, 'height': 900})
    
    # Test light mode
    page.goto('http://localhost:8080')
    page.wait_for_load_state('networkidle')
    page.wait_for_timeout(1000)
    page.screenshot(path='/workspace/docs_light_full.png', full_page=True)
    print("Light mode screenshot taken")
    
    # Test dark mode
    page.evaluate("document.documentElement.setAttribute('data-theme', 'dark')")
    page.wait_for_timeout(500)
    page.screenshot(path='/workspace/docs_dark_full.png', full_page=True)
    print("Dark mode screenshot taken")
    
    # Check CSS variables
    bg = page.evaluate("getComputedStyle(document.body).backgroundColor")
    accent = page.evaluate("getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()")
    text_primary = page.evaluate("getComputedStyle(document.documentElement).getPropertyValue('--text-primary').trim()")
    print(f"Dark mode - bg: {bg}, accent: {accent}, text: {text_primary}")
    
    page.evaluate("document.documentElement.setAttribute('data-theme', 'light')")
    page.wait_for_timeout(300)
    bg = page.evaluate("getComputedStyle(document.body).backgroundColor")
    accent = page.evaluate("getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()")
    text_primary = page.evaluate("getComputedStyle(document.documentElement).getPropertyValue('--text-primary').trim()")
    print(f"Light mode - bg: {bg}, accent: {accent}, text: {text_primary}")
    
    # Verify key elements exist
    assert page.locator('.site-header').is_visible(), "Header missing"
    assert page.locator('.hero').is_visible(), "Hero section missing"
    assert page.locator('.features-grid').is_visible(), "Features grid missing"
    assert page.locator('.site-footer').is_visible(), "Footer missing"
    print("All key elements present")
    
    browser.close()
    print("Tests passed!")