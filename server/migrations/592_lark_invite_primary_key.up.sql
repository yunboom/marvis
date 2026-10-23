-- 把并发建好的唯一索引挂为 lark_invite 的主键。
ALTER TABLE lark_invite
    ADD CONSTRAINT lark_invite_pkey PRIMARY KEY USING INDEX lark_invite_pkey_uidx;
