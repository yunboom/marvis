-- 删除约束会连带删除被它接管的索引，591 的 down 因 IF EXISTS 变成空操作。
ALTER TABLE lark_invite DROP CONSTRAINT IF EXISTS lark_invite_pkey;
