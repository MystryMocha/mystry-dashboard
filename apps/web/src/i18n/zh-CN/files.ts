import type en from '../en/files';

/** 文件管理文案（简体中文）。 */
export default {
  'files.validation.nameEmpty': '名称不能为空',
  'files.validation.nameSeparator': '名称里不能有 / 或 \\',
  'files.validation.folderNameEmpty': '文件夹名称不能为空',
  'files.validation.folderNameSeparator': '文件夹名称里不能有 / 或 \\',
  'files.rename.sameName': '新名称与旧名称相同',
  'files.download.busy': '下载繁忙，请稍后重试',

  'files.menu.downloading': '下载中…',
  'files.row.open': '打开 {name}',
  'files.row.edit': '编辑 {name}',
  'files.row.actions': '{name} 的操作',
  'files.row.preparingDownload': '正在准备下载…',
  'files.row.folderMeta': '文件夹 · {modified}',

  'files.nav.parent': '上级目录',
  'files.nav.breadcrumbs': '当前路径',
  'files.nav.root': '实例根目录',

  'files.toolbar.refreshLabel': '刷新文件列表',
  'files.toolbar.newFolder': '新建文件夹',
  'files.toolbar.uploading': '上传中…',

  'files.list.errorWithStale': '{error} 当前继续显示上次成功读取的文件列表。',
  'files.list.retrying': '正在重试…',
  'files.list.reload': '重新读取',
  'files.list.loading': '正在读取文件列表…',
  'files.list.saved': '文件已保存。',
  'files.empty.title': '当前目录为空。',
  'files.empty.body': '可以上传文件，或新建一个文件夹。',

  'files.edit.title': '编辑文件',
  'files.edit.closeLabel': '关闭编辑',
  'files.edit.contentLabel': '文件内容：{path}',

  'files.rename.hint': '只能在当前文件夹里改名，名称里不能有 / 或 \\。',
  'files.rename.newName': '新名称',
  'files.rename.renaming': '重命名中…',

  'files.mkdir.location': '将在「/{path}」下创建。',
  'files.mkdir.name': '文件夹名称',
  'files.mkdir.placeholder': '例如 plugins',
  'files.mkdir.creating': '创建中…',
  'files.mkdir.create': '创建',

  'files.delete.folderTitle': '删除文件夹「{name}」？',
  'files.delete.fileTitle': '删除文件「{name}」？',
  'files.delete.folderBody': '将删除文件夹「/{path}」和里面的所有文件，无法恢复。',
  'files.delete.fileBody': '将删除文件「/{path}」，无法恢复。',
  'files.delete.deletingFolder': '正在删除文件夹…',
  'files.delete.deletingFile': '正在删除文件…',
  'files.delete.confirm': '确认删除',
} satisfies Record<keyof typeof en, string>;
