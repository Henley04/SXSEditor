const { app, BrowserWindow } = require('electron');
const path = require('path');

// Must be before app.whenReady()
app.commandLine.appendSwitch('enable-features', 'WebMachineLearningNeuralNetwork');
app.commandLine.appendSwitch('enable-unsafe-webgpu');

app.whenReady().then(async () => {
    const win = new BrowserWindow({
        width: 600, height: 400,
        webPreferences: {
            contextIsolation: false,
            sandbox: false,
        },
    });

    win.webContents.on('console-message', (e, level, msg) => {
        console.log(`[renderer] ${msg}`);
    });

    win.webContents.on('did-finish-load', async () => {
        // Wait for tests to complete
        setTimeout(async () => {
            const text = await win.webContents.executeJavaScript(
                "document.getElementById('log').textContent"
            );
            console.log('\n=== Test Results ===');
            console.log(text);
            app.quit();
        }, 5000);
    });

    await win.loadFile(process.argv[2] || 'test_dql_rank.html');
});

app.on('window-all-closed', () => app.quit());
