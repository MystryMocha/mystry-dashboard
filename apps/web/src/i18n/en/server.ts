import { SERVER_MESSAGES } from '@mystry/shared';

/** 服务端返回的消息：英文模板以共享包为唯一来源，这里直接合并进英文主表。 */
export default {
  ...SERVER_MESSAGES,
} satisfies Record<string, string>;
