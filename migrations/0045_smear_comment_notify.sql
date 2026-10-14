-- 抹片討論的 @ 要能回到該診斷。notifications.question_id 是考題,
-- 不拿來塞 dx slug。mentions.question_id 又是 NOT NULL,所以這條路徑
-- 只寫 notifications,不寫 mentions。
ALTER TABLE notifications ADD COLUMN dx_id TEXT;
