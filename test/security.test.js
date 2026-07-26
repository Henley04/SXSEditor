const { expect } = require('chai');
const path = require('node:path');

describe('Security Module', function () {
  let security;
  let authorizePath, isPathAllowed, isSystemPath;

  before(function () {
    // In test environment, require('electron') returns the binary path string.
    // We need to mock it before requiring the security module.
    const electronPath = require.resolve('electron');
    const mockElectron = {
      app: {
        getPath: (name) => {
          const paths = {
            userData: 'C:\\Users\\test\\AppData\\Roaming\\sxseditor',
            documents: 'C:\\Users\\test\\Documents',
            desktop: 'C:\\Users\\test\\Desktop',
            home: 'C:\\Users\\test',
            temp: 'C:\\Users\\test\\AppData\\Local\\Temp',
          };
          return paths[name] || 'C:\\temp';
        },
      },
    };

    // Override the electron module cache
    require.cache[electronPath] = {
      id: electronPath,
      filename: electronPath,
      loaded: true,
      exports: mockElectron,
    };

    // Clear the security module cache to force re-require with mocked electron
    const securityPath = require.resolve('../src/main/security');
    delete require.cache[securityPath];

    security = require('../src/main/security');
    authorizePath = security.authorizePath;
    isPathAllowed = security.isPathAllowed;
    isSystemPath = security.isSystemPath;
  });

  after(function () {
    // Restore electron module cache
    const electronPath = require.resolve('electron');
    delete require.cache[electronPath];

    // Clear security module cache
    const securityPath = require.resolve('../src/main/security');
    delete require.cache[securityPath];
  });

  describe('isPathAllowed', function () {
    it('should allow paths in userData directory', function () {
      const filePath = path.join('C:\\Users\\test\\AppData\\Roaming\\sxseditor', 'settings.json');
      expect(isPathAllowed(filePath)).to.be.true;
    });

    it('should allow paths in documents directory', function () {
      const filePath = path.join('C:\\Users\\test\\Documents', 'project.sxs');
      expect(isPathAllowed(filePath)).to.be.true;
    });

    it('should allow paths in desktop directory', function () {
      const filePath = path.join('C:\\Users\\test\\Desktop', 'file.txt');
      expect(isPathAllowed(filePath)).to.be.true;
    });

    it('should allow paths in home directory', function () {
      const filePath = path.join('C:\\Users\\test', 'file.txt');
      expect(isPathAllowed(filePath)).to.be.true;
    });

    it('should allow paths in temp directory', function () {
      const filePath = path.join('C:\\Users\\test\\AppData\\Local\\Temp', 'temp.wav');
      expect(isPathAllowed(filePath)).to.be.true;
    });

    it('should reject paths in system directories', function () {
      const filePath = 'C:\\Windows\\System32\\cmd.exe';
      expect(isPathAllowed(filePath)).to.be.false;
    });

    it('should reject paths in Program Files', function () {
      const filePath = 'C:\\Program Files\\SomeApp\\file.exe';
      expect(isPathAllowed(filePath)).to.be.false;
    });

    it('should reject arbitrary paths', function () {
      const filePath = 'D:\\SomeRandomPath\\file.txt';
      expect(isPathAllowed(filePath)).to.be.false;
    });

    it('should reject sibling-prefix confusion (home=/Users/test vs /Users/testevil)', function () {
      // Without a separator after the allowed prefix, a path like
      // C:\Users\testevil would be wrongly allowed because it startsWith
      // the home dir C:\Users\test.
      const filePath = 'C:\\Users\\testevil\\steal.txt';
      expect(isPathAllowed(filePath)).to.be.false;
    });
  });

  describe('authorizePath', function () {
    it('should authorize a path and allow subsequent access', function () {
      const filePath = 'D:\\Projects\\test.sxs';
      authorizePath(filePath);
      expect(isPathAllowed(filePath)).to.be.true;
    });

    it('should authorize the directory of a path', function () {
      const filePath = 'D:\\Projects\\subdir\\test.sxs';
      authorizePath(filePath);
      const siblingFile = path.join(path.dirname(filePath), 'other.txt');
      expect(isPathAllowed(siblingFile)).to.be.true;
    });

    it('should handle empty string gracefully', function () {
      authorizePath('');
    });

    it('should handle null gracefully', function () {
      authorizePath(null);
    });

    it('should handle undefined gracefully', function () {
      authorizePath(undefined);
    });

    it('should evict old entries when exceeding 1000', function () {
      for (let i = 0; i < 1100; i++) {
        authorizePath(`D:\\temp\\path${i}\\file.txt`);
      }
      expect(isPathAllowed('D:\\temp\\path1099\\file.txt')).to.be.true;
    });
  });

  describe('isSystemPath', function () {
    it('should detect C:\\Windows as system path', function () {
      expect(isSystemPath('C:\\Windows')).to.be.true;
    });

    it('should detect C:\\Windows\\System32 as system path', function () {
      expect(isSystemPath('C:\\Windows\\System32')).to.be.true;
    });

    it('should detect C:\\Program Files as system path', function () {
      expect(isSystemPath('C:\\Program Files')).to.be.true;
    });

    it('should detect C:\\Program Files (x86) as system path', function () {
      expect(isSystemPath('C:\\Program Files (x86)')).to.be.true;
    });

    it('should detect C:\\ProgramData as system path', function () {
      expect(isSystemPath('C:\\ProgramData')).to.be.true;
    });

    it('should not detect user paths as system path', function () {
      expect(isSystemPath('C:\\Users\\test\\Documents')).to.be.false;
    });

    it('should not detect app data as system path', function () {
      expect(isSystemPath('C:\\Users\\test\\AppData\\Roaming\\sxseditor')).to.be.false;
    });
  });
});
