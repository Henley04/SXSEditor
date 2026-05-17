const WebSocket = require('ws');
const http = require('http');

http.get('http://127.0.0.1:9222/json', (res) => {
  let data = '';
  res.on('data', (chunk) => data += chunk);
  res.on('end', () => {
    const targets = JSON.parse(data);
    const mainTarget = targets[0];
    console.log('Connecting to:', mainTarget.webSocketDebuggerUrl);

    const ws = new WebSocket(mainTarget.webSocketDebuggerUrl);
    let id = 0;

    function sendCommand(method, params) {
      return new Promise((resolve) => {
        const cmdId = ++id;
        const handler = (msg) => {
          const parsed = JSON.parse(msg.toString());
          if (parsed.id === cmdId) {
            ws.removeListener('message', handler);
            resolve(parsed);
          }
        };
        ws.on('message', handler);
        ws.send(JSON.stringify({ id: cmdId, method, params }));
      });
    }

    function delay(ms) {
      return new Promise(resolve => setTimeout(resolve, ms));
    }

    ws.on('open', async () => {
      try {
        // Simulate Alt key to activate menu bar
        console.log('Pressing Alt to activate menu...');
        await sendCommand('Input.dispatchKeyEvent', {
          type: 'keyDown',
          key: 'Alt',
          code: 'AltLeft',
          windowsVirtualKeyCode: 18
        });
        await delay(100);
        await sendCommand('Input.dispatchKeyEvent', {
          type: 'keyUp',
          key: 'Alt',
          code: 'AltLeft',
          windowsVirtualKeyCode: 18
        });
        await delay(500);

        // Press 'S' to open the "设置" menu (Alt+S shortcut)
        console.log('Pressing S for 设置 menu...');
        await sendCommand('Input.dispatchKeyEvent', {
          type: 'keyDown',
          key: 's',
          code: 'KeyS',
          windowsVirtualKeyCode: 83
        });
        await delay(100);
        await sendCommand('Input.dispatchKeyEvent', {
          type: 'keyUp',
          key: 's',
          code: 'KeyS',
          windowsVirtualKeyCode: 83
        });
        await delay(500);

        // Press Enter to select "Settings"
        console.log('Pressing Enter to select Settings...');
        await sendCommand('Input.dispatchKeyEvent', {
          type: 'keyDown',
          key: 'Enter',
          code: 'Enter',
          windowsVirtualKeyCode: 13
        });
        await delay(100);
        await sendCommand('Input.dispatchKeyEvent', {
          type: 'keyUp',
          key: 'Enter',
          code: 'Enter',
          windowsVirtualKeyCode: 13
        });
        await delay(2000);

        // Check if settings window opened
        console.log('Checking for new targets...');
        http.get('http://127.0.0.1:9222/json', (res2) => {
          let data2 = '';
          res2.on('data', (chunk) => data2 += chunk);
          res2.on('end', () => {
            const targets2 = JSON.parse(data2);
            console.log('Targets:', JSON.stringify(targets2.map(t => ({ title: t.title, url: t.url })), null, 2));
            ws.close();
          });
        });
      } catch (e) {
        console.error('Error:', e);
        ws.close();
      }
    });
  });
}).on('error', (e) => console.error(e));
