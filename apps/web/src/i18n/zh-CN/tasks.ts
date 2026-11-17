import type en from '../en/tasks';

/** 任务中心、通用弹窗、错误汇总、菜单与请求错误文案（简体中文）。 */
export default {
  'tasks.type.download': '下载核心',
  'tasks.type.extract': '解压文件',
  'tasks.type.deploy': '部署实例',
  'tasks.type.import': '导入服务端',
  'tasks.type.backup': '备份服务器',
  'tasks.type.restore': '还原备份',

  'tasks.center.title': '任务中心',
  'tasks.center.open_one': '打开任务中心，{count} 个任务进行中',
  'tasks.center.open_other': '打开任务中心，{count} 个任务进行中',
  'tasks.center.close': '关闭任务中心',
  'tasks.center.refresh': '刷新任务',
  'tasks.center.activeBadge': '{count} 进行中',
  'tasks.center.stale': '状态可能已过期：{error}',
  'tasks.center.lastSync': '上次成功同步：{time}',
  'tasks.center.loading': '正在读取任务列表…',
  'tasks.center.empty.title': '暂无任务',
  'tasks.center.empty.body': '开始部署或导入后，进度会显示在这里。',
  'tasks.card.runningProgress': '{percent} 进行中',
  'tasks.card.progressLabel': '{type}进度',
  'tasks.card.viewInstance': '查看实例',

  'menu.more': '更多操作',

  'dialog.confirm.requireText': '请输入「{text}」以确认操作',
  'dialog.confirm.busy': '处理中…',

  'dialog.error.copy': '复制错误',
  'dialog.error.copied': '已复制',
  'dialog.error.copyFailed': '复制失败',
  'dialog.error.viewDetails': '查看详情',
  'dialog.error.detailHint': '完整错误内容，可复制后用于排查。',
  'dialog.error.closeLabel': '关闭错误详情',
  'dialog.error.copiedStatus': '错误内容已复制到剪贴板',
  'dialog.error.copyFailedStatus': '复制失败，请在内容区域中手动选择复制',
  'dialog.error.copyAll': '复制全部',

  'request.failed': '请求失败（{status}）',
  'request.aborted': '操作已取消',
  'request.download.popupBlocked': '浏览器拦截了下载窗口，请允许弹窗后重试',
  'request.download.ticketExpiredRetry': '下载票据已过期，请重试',
  'request.download.ticketExpired': '下载票据已过期',
  'request.download.failed': '文件下载失败',
  'request.stopPending': '服务仍在保存，请等待或选择强制停止',
  'request.taskFailed': '任务失败',
} satisfies Record<keyof typeof en, string>;
