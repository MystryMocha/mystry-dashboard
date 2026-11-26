// String tables split by UI area, merged here into one flat key table. Keys are named with an area or glossary prefix, and must not collide across files.
import commonMessages from './common';
import shellMessages from './shell';
import loginMessages from './login';
import dashboardMessages from './dashboard';
import homeMessages from './home';
import settingsMessages from './settings';
import deployMessages from './deploy';
import importMessages from './import';
import jvmMessages from './jvm';
import instanceMessages from './instance';
import consoleMessages from './console';
import configMessages from './config';
import filesMessages from './files';
import backupsMessages from './backups';
import tasksMessages from './tasks';
import multiplayerMessages from './multiplayer';
import remoteAccessMessages from './remoteAccess';
import serverMessages from './server';

export default {
  ...commonMessages,
  ...shellMessages,
  ...loginMessages,
  ...dashboardMessages,
  ...homeMessages,
  ...settingsMessages,
  ...deployMessages,
  ...importMessages,
  ...jvmMessages,
  ...instanceMessages,
  ...consoleMessages,
  ...configMessages,
  ...filesMessages,
  ...backupsMessages,
  ...tasksMessages,
  ...multiplayerMessages,
  ...remoteAccessMessages,
  ...serverMessages,
};
