// 服务端消息按区域拆分，与 packages/shared/src/messages/ 一一对应。
import commonMessages from './server/common';
import authMessages from './server/auth';
import filesMessages from './server/files';
import deployMessages from './server/deploy';
import importsMessages from './server/imports';
import instanceMessages from './server/instance';
import systemMessages from './server/system';
import tasksMessages from './server/tasks';
import jvmMessages from './server/jvm';
import type en from '../en/server';

export default {
  ...commonMessages,
  ...authMessages,
  ...filesMessages,
  ...deployMessages,
  ...importsMessages,
  ...instanceMessages,
  ...systemMessages,
  ...tasksMessages,
  ...jvmMessages,
} satisfies Record<keyof typeof en, string>;
