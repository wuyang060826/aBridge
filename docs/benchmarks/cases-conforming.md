# 按任务标准审核后的报告

政策版本：task-validity-v1。本轮剔除 0 例。

| 集合            | 严格成功 / 分母 |
| --------------- | --------------- |
| 主对照 seed 0/1 | 12/12           |
| 额外 seed 2     | 6/6             |

两侧使用相同模型目录与评测器；网络、模型响应及工具等待均可能影响端到端预算。超时全部保留，不属于任务不合规，不能据此剔除。

任务未初始化仅指Agent动作前已由独立证据确认的错误。操作后的异常、任务失败、预算耗尽、模型或工具能力不足都不是排除理由。判分采集异常与任务合规性分别记录；已超时即严格失败，不因奖励未知而剔除。

| 集合   | 任务                   | seed | 严格成功 | 原始奖励 | 失败记录 | 标准审核   |
| ------ | ---------------------- | ---- | -------- | -------- | -------- | ---------- |
| paired | form-sequence-3        | 0    | 是       | 1        | —        | 符合，保留 |
| paired | form-sequence-3        | 1    | 是       | 1        | —        | 符合，保留 |
| paired | email-inbox-forward-nl | 0    | 是       | 1        | —        | 符合，保留 |
| paired | email-inbox-forward-nl | 1    | 是       | 1        | —        | 符合，保留 |
| paired | book-flight            | 0    | 是       | 1        | —        | 符合，保留 |
| paired | book-flight            | 1    | 是       | 1        | —        | 符合，保留 |
| paired | navigate-tree          | 0    | 是       | 1        | —        | 符合，保留 |
| paired | navigate-tree          | 1    | 是       | 1        | —        | 符合，保留 |
| paired | click-menu-2           | 0    | 是       | 1        | —        | 符合，保留 |
| paired | click-menu-2           | 1    | 是       | 1        | —        | 符合，保留 |
| paired | multi-layouts          | 0    | 是       | 1        | —        | 符合，保留 |
| paired | multi-layouts          | 1    | 是       | 1        | —        | 符合，保留 |
| extra  | form-sequence-3        | 2    | 是       | 1        | —        | 符合，保留 |
| extra  | email-inbox-forward-nl | 2    | 是       | 1        | —        | 符合，保留 |
| extra  | book-flight            | 2    | 是       | 1        | —        | 符合，保留 |
| extra  | navigate-tree          | 2    | 是       | 1        | —        | 符合，保留 |
| extra  | click-menu-2           | 2    | 是       | 1        | —        | 符合，保留 |
| extra  | multi-layouts          | 2    | 是       | 1        | —        | 符合，保留 |

## 版本历史（不混入最终分母）

| 版本                             | 全量严格成功 | 原始数据                                     |
| -------------------------------- | ------------ | -------------------------------------------- |
| 0.4.14启动修复后基线             | 5/12         | [基线](miniwob-v2-baseline.json)             |
| 早期0.4.12原始基线（不同配置）   | 5/12         | [逐次结果](miniwob-agent-results.json)       |
| 清理Docker后历史重跑（不同配置） | 8/12         | [逐次结果](miniwob-clean-host-results.json)  |
| 本轮stage1基线                   | 3/12         | [逐次结果](miniwob-v2-stage1-baseline.json)  |
| 本轮stage1候选原始判分           | 8/12         | [逐次结果](miniwob-v2-stage1-results.json)   |
| 本轮stage1候选全量重解析         | 9/12         | [逐次结果](miniwob-v2-stage1-rescored.json)  |
| 整合0.4.16前的0.4.14完整修复版   | 11/12        | [逐次结果](miniwob-v2-premerge-results.json) |
| 当前版本                         | 12/12        | [逐次结果](miniwob-v2-results.json)          |

历史数据保留，不用不同版本的最好成绩拼接最终结果。配置不同的历史分数不能用来单独归因本轮优化。stage1原始8/12因CLI诊断误判越权，全量重解析后9/12，见[修正记录](miniwob-v2-stage1-adjudication.json)，没有删除任何样本。额外种子另列，不将重复尝试混入主对照。

## 剔除清单

无。当前没有证据证明这些任务违反约定，不能为提高分数而强行剔除。

## 审核标准

- source_integrity_violation：任务源码或依赖不符合固定上游哈希，无法视为既定任务
- task_not_initialized：有独立证据证明任务未按约定种子、模式或初始状态启动
- undeclared_external_prerequisite：任务实际依赖评测约定未提供的外部账号、服务或数据
- outside_declared_task_scope：任务本身要求声明范围之外的操作，须有独立任务契约证据；工具实现缺陷不属于此类

固定上游任务在本地运行；日期范围和界面变化属于原始任务内容，不因难度或缺少语义标注而排除。工具不足应作为产品问题修复。

[原始逐次结果](miniwob-v2-results.json) · [额外种子结果](miniwob-v2-extra.json) · [通用修复报告](browser-reliability-v2.md)

这是小样本、单模型的探索性结果，不是官方榜单或大样本泛化结论。
