ALTER TABLE `messages` ADD `parent_id` text;--> statement-breakpoint
ALTER TABLE `messages` ADD `active_child_id` text;--> statement-breakpoint
ALTER TABLE `conversations` ADD `active_root_id` text;--> statement-breakpoint
-- 分支树回填：存量消息都是线性链，把每条非首条消息的 parent_id 指向同会话中
-- idx 比它小的最近一条消息（幂等：只处理 parent_id 为空且有前驱的行）。
-- 回填后旧会话 = 单链树，active_child_id 全为 null = 沿 idx 最大孩子走，行为不变。
UPDATE `messages` SET `parent_id` = (
  SELECT m2.`id` FROM `messages` m2
  WHERE m2.`conversation_id` = `messages`.`conversation_id` AND m2.`idx` < `messages`.`idx`
  ORDER BY m2.`idx` DESC
  LIMIT 1
)
WHERE `parent_id` IS NULL AND EXISTS (
  SELECT 1 FROM `messages` m3
  WHERE m3.`conversation_id` = `messages`.`conversation_id` AND m3.`idx` < `messages`.`idx`
);
