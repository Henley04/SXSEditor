Git 规则
1. 每次提交都必须有对应的 issue 号
2. 每次提交都必须有对应的 commit message
3. 每次开始修改之前，必须先git备份
4. 执行破坏性修改之前备份
5. 执行破坏性修改之后，必须测试
6. 测试通过后git备份
7. 打包测试用npm run package:lite
8. 改了新功能之后要更新readme.md