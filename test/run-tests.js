/**
 * 综合测试运行脚本
 * 运行所有测试并生成报告
 */

const { execSync } = require('child_process');
const path = require('path');

console.log('='.repeat(60));
console.log('SXSEditor 自动化测试');
console.log('='.repeat(60));

try {
  const result = execSync('npx mocha --require ./test/setup.js "test/**/*.test.js" --timeout 30000 --reporter spec', {
    cwd: __dirname,
    stdio: 'inherit',
  });

  console.log('\n' + '='.repeat(60));
  console.log('测试完成!');
  console.log('='.repeat(60));
} catch (error) {
  console.log('\n' + '='.repeat(60));
  console.log('测试完成 (有失败)');
  console.log('='.repeat(60));
  process.exit(error.status || 1);
}
