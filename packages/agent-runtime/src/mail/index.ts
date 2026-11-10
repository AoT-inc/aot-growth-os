export { createMailEffectTool, type MailEffectTool, type MailEffectToolOptions, type MailSenderConfig } from './effect-tool.ts';
export {
  createMailToolExecutor, MAIL_SEND_TOOL, mailToolSpecs, MailToolError, senderKeyOfTarget,
  type MailEffectOutcome, type MailEffectRunner, type MailEffectStep, type MailToolErrorCode, type MailToolExecutorOptions,
} from './tools.ts';
export { createFakeMailTransport, type FakeMailOutcome, type FakeMailTransport, type FakeMailTransportOptions } from './fake-transport.ts';
