# 08: 智能体自带知识库能力——meta-skill、lint、stale

**What to build:** 智能体在任何任务里都知道 `marvis kb` 怎么用和有哪些知识库（含描述）；能在本地仓库运行 `marvis kb lint`（死链、孤儿页、缺字段、引用失效、index 不一致）和 `marvis kb stale`（按论断比对证据版本），输出 JSON。

**Blocked by:** 04

**Status:** done

- [x] meta-skill 新增知识库一节
- [x] lint、stale 命令与表驱动测试
