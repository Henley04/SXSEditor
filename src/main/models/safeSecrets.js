'use strict';
// 兼容层：模型端点的密钥存储与插件密钥共用同一份实现（见 ../secretsStore.js）。
// 保留这个文件是为了不动 models 的调用点与既有测试路径；加密、0600、tmp→rename、
// 以及"降级时必须说出来"这四件事只有一个实现，避免两处漂移。
module.exports = require('../secretsStore.js');
