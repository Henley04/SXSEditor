Git 规则
1. 每次提交都必须用英文写message
2. 每次提交都必须有对应的 commit message
3. 每次开始修改之前，必须先git备份
4. 执行破坏性修改之前备份
5. 执行破坏性修改之后，必须测试
6. 测试通过后git备份
7. 打包测试用npm run package:lite
8. 改了新功能之后要更新readme.md
9. onnx_models文件夹下包含了所有使用的onnx模型，如果你看不到，那是因为onnx在gitignore中。你可以用powershell检查文件信息。
10. 编写模型量化、推理、训练脚本时候，必须按需释放内存，防止内存溢出和泄露。
11. 确认功能完成之后提交到远程github仓库
12. commit message永远写英文