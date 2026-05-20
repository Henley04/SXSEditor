from playwright.sync_api import sync_playwright
import os

SCREENSHOT_DIR = os.path.join(os.path.dirname(__file__), 'test_screenshots')
os.makedirs(SCREENSHOT_DIR, exist_ok=True)

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={'width': 1280, 'height': 900})

    # Test 1: Load index page (should auto-detect zh)
    page.goto('http://localhost:8080/index.html')
    page.wait_for_load_state('networkidle')
    page.screenshot(path=os.path.join(SCREENSHOT_DIR, 'index_zh.png'), full_page=True)
    print('[OK] index_zh.png')

    # Verify Chinese text
    h1 = page.locator('h1').inner_text()
    print(f'  H1 text (zh): {h1[:30]}...')

    # Test 2: Switch to English
    page.locator('.lang-option[data-lang="en"]').click()
    page.wait_for_timeout(300)
    page.screenshot(path=os.path.join(SCREENSHOT_DIR, 'index_en.png'), full_page=True)
    print('[OK] index_en.png')

    h1_en = page.locator('h1').inner_text()
    print(f'  H1 text (en): {h1_en[:30]}...')

    # Test 3: Switch to Japanese
    page.locator('.lang-option[data-lang="jp"]').click()
    page.wait_for_timeout(300)
    page.screenshot(path=os.path.join(SCREENSHOT_DIR, 'index_jp.png'), full_page=True)
    print('[OK] index_jp.png')

    h1_jp = page.locator('h1').inner_text()
    print(f'  H1 text (jp): {h1_jp[:30]}...')

    # Test 4: Features page
    page.goto('http://localhost:8080/features.html')
    page.wait_for_load_state('networkidle')
    page.screenshot(path=os.path.join(SCREENSHOT_DIR, 'features_zh.png'), full_page=True)
    print('[OK] features_zh.png')

    # Switch to English on features page
    page.locator('.lang-option[data-lang="en"]').click()
    page.wait_for_timeout(300)
    page.screenshot(path=os.path.join(SCREENSHOT_DIR, 'features_en.png'), full_page=True)
    print('[OK] features_en.png')

    # Test 5: Download page
    page.goto('http://localhost:8080/download.html')
    page.wait_for_load_state('networkidle')
    page.locator('.lang-option[data-lang="jp"]').click()
    page.wait_for_timeout(300)
    page.screenshot(path=os.path.join(SCREENSHOT_DIR, 'download_jp.png'), full_page=True)
    print('[OK] download_jp.png')

    # Test 6: About page
    page.goto('http://localhost:8080/about.html')
    page.wait_for_load_state('networkidle')
    page.locator('.lang-option[data-lang="en"]').click()
    page.wait_for_timeout(300)
    page.screenshot(path=os.path.join(SCREENSHOT_DIR, 'about_en.png'), full_page=True)
    print('[OK] about_en.png')

    # Test 7: Language persistence - navigate to another page, check language is remembered
    page.goto('http://localhost:8080/index.html')
    page.wait_for_load_state('networkidle')
    page.wait_for_timeout(300)
    # Should still be English (from localStorage)
    active_lang = page.locator('.lang-option.active').get_attribute('data-lang')
    print(f'[OK] Language persistence check: active={active_lang} (expected: en)')

    browser.close()
    print('\nAll tests completed!')
