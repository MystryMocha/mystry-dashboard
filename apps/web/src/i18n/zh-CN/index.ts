// 按界面区域拆分的文案表，在这里合并为扁平键表。键以区域或术语表前缀命名，不同文件之间不得重名。
import commonMessages from './common';
import shellMessages from './shell';
import loginMessages from './login';
import dashboardMessages from './dashboard';
import nodesMessages from './nodes';
import deployMessages from './deploy';
import importMessages from './import';
import jvmMessages from './jvm';
import instanceMessages from './instance';
import consoleMessages from './console';
import configMessages from './config';
import filesMessages from './files';
import tasksMessages from './tasks';

export default {
  ...commonMessages,
  ...shellMessages,
  ...loginMessages,
  ...dashboardMessages,
  ...nodesMessages,
  ...deployMessages,
  ...importMessages,
  ...jvmMessages,
  ...instanceMessages,
  ...consoleMessages,
  ...configMessages,
  ...filesMessages,
  ...tasksMessages,
};
