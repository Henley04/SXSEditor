# 对齐Python参考实现 - 检查清单

## mel2token构建逻辑
- [x] `_buildMel2token()`使用ph_locations + 重复填充算法，与Python `DataProcessor.preprocess()`一致
- [x] 每个音符的起始帧位置基于duration累积精确计算
- [x] token序列通过重复填充映射到mel帧（mel2token[k:k+j] = range(ph_idx, ph_idx+j)+1）
- [x] EOW token总是放在next_phoneme_start - 1位置
- [x] 处理重叠情况：当起始帧已被占用时向后查找空闲位置
- [x] mel2token.max() <= tokenCount - 1边界检查

## 英文音素SEP位置
- [x] 英文多音素的`<SEP>`放在所有子音素之后（而非子音素之间）
- [x] 每个英文子音素都带`en_`前缀
- [x] token序列格式：BOW, en_ph1, en_ph2, ..., SEP, EOW

## CFG std计算
- [x] 对target区域所有帧和维度计算全局pos_std（而非逐帧）
- [x] 对target区域所有帧和维度计算全局cfg_std
- [x] rescale计算使用全局std：rescale_flow_pred = flow_pred_cfg * pos_std / cfg_std
- [x] 最终结果：rescale_cfg * rescale + (1 - rescale_cfg) * cfg

## auto_shift
- [x] melody模式：f0_shift = round(log2(pt_f0_median / gt_f0_median) * 1200 / 100)
- [x] score模式：f0_shift = round(pt_median - gt_median)
- [x] f0_shift应用于F0量化：f0_to_coarse(gt_f0, f0_shift=f0_shift * 5)
- [x] f0_shift应用于note_pitch：note_pitch[note_pitch > 0] += f0_shift
- [x] UI中有auto_shift开关

## F0帧率插值
- [x] RMVPE输出F0从16kHz/160hop插值到24kHz/480hop
- [x] 使用线性插值（与Python scipy.interpolate.interp1d一致）
- [x] 超出范围部分填充0
- [x] 插值后帧数 = floor(duration * 24000 / 480)

## merge_phoneme
- [x] 合并相邻相同SP音符（phoneme都是`<SP>`，note_type和note_pitch相同）
- [x] 合并后duration累加

## Bug修复
- [x] renderer.js中`pipeline`变量改为`pipelineInitialized`
- [x] 导出混合startSample使用秒数（非拍数）计算
- [x] rmvpePitchDetector.js dispose调用session.release()

## MIDI文件导入
- [x] 解析MIDI note_on/note_off事件
- [x] 关联lyrics元事件到对应音符
- [x] 处理重叠音符（修剪前一个音符结束时间）
- [x] 长间隔(>0.2s)插入显式SP音符
- [x] lyric确定note_type：空="啦"(type=2), `<SP>`=type=1, `-`=type=3
- [x] UI中有MIDI导入按钮

## 英文G2P
- [x] 内置英文单词到CMU音素的映射词典
- [x] 未知英文单词使用字母级回退
- [x] 输出格式：`en_` 前缀 + `-` 分隔的音素

## 测试覆盖
- [x] mel2token构建逻辑测试通过
- [x] 英文音素SEP位置测试通过
- [x] CFG全局std计算测试通过
- [x] auto_shift计算测试通过
- [x] F0插值测试通过
- [x] merge_phoneme测试通过
