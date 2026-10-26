# 06: 混合检索

**What to build:** 成员和智能体检索知识库，关键字 + 向量用 RRF 融合（spec 07.7、决策 100），没配 embedding 时降级为关键字；搜索结果页与没有结果页（设计稿 6.x）。

**Blocked by:** 01

**Status:** ready-for-agent

- [ ] `server/pkg/embedding`（OpenAI 兼容 /v1/embeddings，`MARVIS_EMBEDDING_BASE_URL/API_KEY/MODEL`，.env.example 与 selfhost compose）
- [ ] 合并后异步建向量（content_hash 去重、每批 ≤100、补算存量），HNSW + iterative_scan relaxed_order + materialized CTE
- [ ] `GET /api/kb/search` 返回 mode / score；CLI `kb search` 走同一接口
- [ ] 混合检索支持 `type` 过滤（带 `type` 时关键词可空，按类型列出该类页面），响应带 `total`；带关键词按相关度返回前 `limit` 条（1–50）不翻页，只按 `type` 列出时按路径排序、`cursor` 游标翻页（`limit` 1–200，默认 200，响应 `next_cursor`）（决策 105）
- [ ] RRF 融合单测、降级测试
