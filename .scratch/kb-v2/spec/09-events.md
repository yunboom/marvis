# 9 实时事件（WebSocket）

事件只让前端的 TanStack Query 缓存失效，不直接写入状态（AGENTS.md「State Rules」）。

| 事件 | 触发 | 前端失效的查询 | 
| kb.draft.updated | 草稿写入（1 秒内合并发送） | 作业详情、页面树草稿标记、阅读页草稿视图、变更请求详情 | 
| kb.job.updated | 作业名称 / 最后回复变化、关联草稿 | 作业列表、作业详情 | 
| kb.mr.created / updated | 变更请求新建 / 标题说明变化 | 待审核列表、详情、作业详情、阅读页待审核提示 | 
| kb.mr.merged / closed | 合并 / 关闭 | 同上 + 页面、页面树、首页、检索、关系图 | 
| kb.mr.commented | 新评论 | 评论列表 | 
| kb.annotation.changed | 批注新建 / 状态变化 | 批注列表、首页计数、页面批注栏 | 
| kb.base.changed | 知识库新建 / 配置保存 / 删除 | 知识库列表、详情 | 

事件示例

```
{
  "type": "kb.draft.updated",                                 // 事件类型
  "workspace_id": "ws_8f2a1c",                                // 工作区
  "payload": {                                                // 内容
    "draft_id": "9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a",       // 草稿
    "job_id": "c4d5e6f7-1a2b-4c3d-8e9f-0a1b2c3d4e5f",         // 关联的作业（没有关联为 null）
    "knowledge_base_id": "5b1f0c2e-8a6d-4e1b-9f7a-2c3d4e5f6a7b",  // 知识库
    "version": 12,                                            // 草稿版本
    "page_ids": [                                             // 这一秒内改动的页面
      "0c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f"
    ]
  }
}
```
