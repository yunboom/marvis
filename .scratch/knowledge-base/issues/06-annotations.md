# 06: 批注

**What to build:** 成员在页面选中句子或对整页写批注，在页面右侧和「批注」标签按状态查看、标为不处理、勾选；页面改写后找不到原句的批注退化为页面批注。变更请求合并时关联批注变为已解决，关闭时退回待处理。CLI `kb annotate add/list/resolve`。

**Blocked by:** 03

**Status:** ready-for-agent

- [ ] 批注 API 与状态流转
- [ ] 锚点重新定位与退化
- [ ] 与变更请求的联动（合并 / 关闭）
- [ ] UI 与 CLI、测试
