-- The onboarding kickoff becomes one case of the generic hidden instruction
-- kind; every predicate now checks 'instruction' only.
UPDATE chat_message SET message_kind = 'instruction' WHERE message_kind = 'onboarding_kickoff';
