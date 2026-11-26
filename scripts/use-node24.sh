#!/usr/bin/env bash
# 让当前 shell 使用与 CI 一致的 Node 24（.github/workflows/ci.yml: setup-node 24）。
#
# WorkBuddy 托管的 Node 22 默认排在 PATH 前面，直接敲 `node -v` 会得到 22.x；
# 而项目已经在 .nvmrc / package.json engines 里锁定 24.x。
# 用法：source scripts/use-node24.sh   （必须 source，export 才留在当前 shell）
export PATH="/c/Program Files/nodejs:$PATH"
printf 'Node: %s | npm: %s\n' "$(node -v)" "$(npm -v)"
